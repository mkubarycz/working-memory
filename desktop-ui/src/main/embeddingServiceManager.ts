import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EMBEDDING_HOST_PORT, embeddingHostStatusSchema, embeddingHostSettingsSchema, type EmbeddingHostSettings } from '../../../control-plane/src/embeddingContract';
import { readEmbeddingHostSettings } from './embeddingHostService';
import { acquireLock, AlreadyRunningError } from '../../../control-plane/src/lockfile';

const execute = promisify(execFile);
const label = 'com.workingmemory.embeddings';
const taskName = 'Working Memory Embeddings';
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function embeddingServicePlist(executable: string, home: string, application?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string>
${application ? `<string>${xml(application)}</string>` : ''}
<string>--embedding-service</string><string>--embedding-service-home</string><string>${xml(home)}</string></array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string></string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>PathState</key>
<dict><key>${xml(executable)}</key><true/></dict></dict>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(home, 'service.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, 'service.stderr.log'))}</string>
</dict></plist>\n`;
}

export class EmbeddingServiceManager {
  private installing: Promise<{ endpoint: string; token: string }> | undefined;
  constructor(private executable: string, private home: string, private version: string, private application?: string) {}
  readSettings(): EmbeddingHostSettings { return readEmbeddingHostSettings(this.home); }
  async setRetention(idleTimeoutMinutes: number | null): Promise<EmbeddingHostSettings> {
    const settings = embeddingHostSettingsSchema.parse({ idleTimeoutMinutes });
    const { token } = await this.ensure();
    const response = await fetch(`http://127.0.0.1:${EMBEDDING_HOST_PORT}/settings`, {
      method: 'PUT', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(settings), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Could not save model retention (HTTP ${response.status}). Retry from Embeddings diagnostics.`);
    return embeddingHostSettingsSchema.parse(await response.json());
  }
  ensure() {
    return this.installing ??= this.install().finally(() => { this.installing = undefined; });
  }
  private async install() {
    for (let attempt = 0; attempt < 80; attempt++) {
      let lock;
      try { lock = acquireLock(join(this.home, 'service-install.lock')); }
      catch (error) {
        if (!(error instanceof AlreadyRunningError)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      try { return await this.installLocked(); }
      finally { lock.release(); }
    }
    throw new Error('Another host service installation is still running. Wait briefly and Retry.');
  }
  private async installLocked() {
    mkdirSync(this.home, { recursive: true });
    const file = join(this.home, 'host-token');
    if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    const token = readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Host inference credentials are invalid; existing credentials have not been replaced.');
    const localEndpoint = `http://127.0.0.1:${EMBEDDING_HOST_PORT}`;
    const healthy = async () => {
      try {
        const response = await fetch(`${localEndpoint}/status`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000), redirect: 'error',
        });
        return response.ok && embeddingHostStatusSchema.parse(await response.json()).version === this.version;
      } catch { return false; }
    };
    if (process.platform === 'darwin') {
      const directory = join(homedir(), 'Library', 'LaunchAgents');
      mkdirSync(directory, { recursive: true });
      const plist = join(directory, `${label}.plist`);
      const source = embeddingServicePlist(this.executable, this.home, this.application);
      const changed = !existsSync(plist) || readFileSync(plist, 'utf8') !== source;
      writeFileSync(`${plist}.tmp`, source, { mode: 0o600 });
      renameSync(`${plist}.tmp`, plist);
      const domain = `gui/${process.getuid!()}`;
      let registered = false;
      try { await execute('/bin/launchctl', ['print', `${domain}/${label}`]); registered = true; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && [113, 3].includes(Number(error.code)))) throw error;
      }
      if (registered && (changed || !await healthy())) {
        await execute('/bin/launchctl', ['bootout', `${domain}/${label}`]);
        registered = false;
      }
      if (!registered) {
        for (let attempt = 0; ; attempt++) {
          try { await execute('/bin/launchctl', ['bootstrap', domain, plist]); break; }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && Number(error.code) === 5) || attempt >= 19) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
            try { await execute('/bin/launchctl', ['print', `${domain}/${label}`]); break; }
            catch (queryError) {
              if (!(queryError instanceof Error && 'code' in queryError && [113, 3].includes(Number(queryError.code)))) throw queryError;
            }
          }
        }
      }
    } else if (process.platform === 'win32') {
      if (!await healthy()) {
        const args = `${this.application ? `"${this.application}" ` : ''}--embedding-service --embedding-service-home "${this.home}"`;
        if ([this.home, this.executable, this.application ?? ''].some(path => path.includes('"'))) throw new Error('Invalid host service installation path.');
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
          $ErrorActionPreference = 'Stop'
          $existing = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue
          if ($existing) { Stop-ScheduledTask -TaskName '${taskName}' }
          $action = New-ScheduledTaskAction -Execute $env:WM_SERVICE_EXE -Argument $env:WM_SERVICE_ARGS
          $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
          $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
          $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
          $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
          Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
          Start-ScheduledTask -TaskName '${taskName}'
        `], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '',
          WM_SERVICE_EXE: this.executable, WM_SERVICE_ARGS: args } });
      }
    } else throw new Error('Independent host inference currently supports macOS and Windows.');
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await healthy()) return { endpoint: `http://host.docker.internal:${EMBEDDING_HOST_PORT}`, token };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The host inference service did not start. Check background-service logs and Retry.');
  }
  async restore(): Promise<void> {
    if (existsSync(join(this.home, 'host-token'))) await this.ensure();
  }
}
