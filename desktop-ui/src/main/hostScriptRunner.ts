import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  scriptDefinitionHash, scriptLeaseSchema, validateScriptArguments, type ScriptLease,
} from '../../../control-plane/src/hostScriptPolicy';

export const HOST_SCRIPT_EXAMPLE = `module.exports = async function (parameters) {
  return { greeting: "Hello, " + parameters.name + "!", runtime: process.versions.node, platform: process.platform };
};
`;
export const HOST_SCRIPT_EXAMPLE_PARAMETERS = { name: { type: 'string', required: true, maxLength: 80 } } as const;

const worker = String.raw`
const { compileFunction } = require('node:vm');
const { isBuiltin } = require('node:module');
setInterval(() => {}, 1000);
const finish = async message => {
  await Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
  process.send(message, () => process.exit(0));
};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 131072) { process.stderr.write('Input too large'); process.exit(1); }
});
process.stdin.on('end', async () => {
  try {
    const { source, parameters } = JSON.parse(input);
    const module = { exports: {} };
    const builtin = name => {
      if (typeof name !== 'string' || !isBuiltin(name)) throw new Error('Only Node.js built-in modules are supported');
      return require(name);
    };
    compileFunction(source, ['module', 'exports', 'require'], { filename: 'approved-host-script.cjs' })(module, module.exports, builtin);
    if (typeof module.exports !== 'function') throw new Error('Export a function with module.exports');
    const result = await module.exports(Object.freeze(parameters));
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined || Buffer.byteLength(resultJson) > 65536) throw new Error('Return JSON data up to 64 KiB');
    await finish({ resultJson });
  } catch (error) {
    await finish({ error: String(error && error.message || error).slice(0, 1000) });
  }
});
`;

const watchdog = String.raw`
const { spawn } = require('node:child_process');
const terminate = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(1); }
};
process.on('disconnect', terminate);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 131072) terminate();
});
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input);
    setTimeout(terminate, request.durationMs);
    const child = spawn(process.execPath, ['-e', request.worker], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let result;
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) {
          process.send({ error: 'Host script console output exceeded 64 KiB' }, terminate);
        }
      });
    }
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on('message', message => { if (result) terminate(); result = message; });
    child.on('error', terminate);
    child.stdin.on('error', terminate);
    child.on('close', code => {
      if (code !== 0 || !result) terminate();
      else process.send(result, () => process.exit(0));
    });
    child.stdin.end(JSON.stringify({ source: request.source, parameters: request.parameters }));
  } catch { terminate(); }
});
`;

export async function hostScriptHostId(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, 'host-id'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error('Host script identity must be a private, user-owned file');
    }
    if (!stat.size) {
      const id = randomUUID();
      await file.writeFile(id);
      await file.sync();
      return id;
    }
    return z.string().uuid().parse((await file.readFile('utf8')).trim());
  } finally { await file.close(); }
}

export async function executeHostScript(
  value: ScriptLease, signal?: AbortSignal, executable = process.execPath,
): Promise<{ resultJson?: string; error?: string }> {
  if (process.platform === 'win32') throw new Error('Generic Node host scripts currently require macOS or Linux');
  const lease = scriptLeaseSchema.parse(value);
  if (scriptDefinitionHash(lease.definition) !== lease.definitionHash) throw new Error('Approved script bytes or parameter contract changed');
  const parameters = validateScriptArguments(lease.definition.parameters, lease.parameters);
  const timeout = Math.min(lease.definition.timeoutMs, lease.deadline - Date.now());
  if (timeout <= 0) throw new Error('Script lease has expired');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-e', watchdog], {
      cwd: homedir(), detached: true,
      env: { HOME: homedir(), TMPDIR: tmpdir(), PATH: '/usr/bin:/bin',
        ELECTRON_RUN_AS_NODE: '1', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let output = 0;
    let result: { resultJson?: string; error?: string } | undefined;
    let failure: Error | undefined;
    const stop = (error?: Error) => {
      if (error) failure ??= error;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
            failure ??= new Error('Could not terminate the host-script process group');
            console.error('[host-scripts] Process group termination failed.');
          }
        }
      }
    };
    const abort = () => stop(new Error('Host-script execution stopped'));
    const onExit = () => stop();
    process.once('exit', onExit);
    const timer = setTimeout(() => stop(new Error('Host script exceeded its time limit')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const countOutput = (chunk: Buffer) => {
      output += chunk.length;
      if (output > 65536) stop(new Error('Host script console output exceeded 64 KiB'));
    };
    child.stdout?.on('data', countOutput);
    child.stderr?.on('data', countOutput);
    child.on('message', (message: unknown) => {
      const parsed = z.union([
        z.object({ resultJson: z.string().refine(text => Buffer.byteLength(text) <= 65536) }).strict(),
        z.object({ error: z.string().min(1).max(1000) }).strict(),
      ]).safeParse(message);
      if (!parsed.success || result) stop(new Error('Invalid host-script result'));
      else result = parsed.data;
    });
    child.on('error', () => { failure = new Error('Could not start the Node host-script process'); });
    child.stdin?.on('error', () => { failure ??= new Error('Could not deliver parameters to the host script'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      process.removeListener('exit', onExit);
      signal?.removeEventListener('abort', abort);
      stop();
      if (failure) reject(failure);
      else if (code !== 0 && result?.error) reject(new Error(result.error));
      else if (code !== 0 || !result) reject(new Error('Host script exited without a valid result'));
      else resolve(result);
    });
    child.stdin?.end(JSON.stringify({ source: lease.definition.source, parameters, worker, durationMs: timeout + 500 }));
  });
}
