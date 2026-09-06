import { homedir as systemHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ControlPlaneClient } from '../../../src/controlPlaneClient';
import {
  CONTROL_PLANE_HOME_ENV,
  controlPlanePortFilePath,
  parsePortInfo,
  resolveControlPlaneHome,
} from '../../../src/controlPlaneShared';

export type EnvironmentSource = 'production' | 'override' | 'sandbox';

export interface DesktopEnvironment {
  id: string;
  port: number;
  displayName: string;
  mcpUrl: string;
  source: EnvironmentSource;
}

export interface EnvironmentClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown }>;
  dispose(): Promise<void>;
}

export interface EnvironmentDiscoveryDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  probe?: (environment: DesktopEnvironment) => Promise<boolean>;
  createClient?: (mcpUrl: string) => EnvironmentClient;
}

export interface EnvironmentManagerDependencies extends EnvironmentDiscoveryDependencies {
  readPersistedSelection?: () => Promise<string | null>;
  writePersistedSelection?: (mcpUrl: string) => Promise<void>;
}

export async function readPersistedEnvironment(filePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mcpUrl?: unknown };
    return typeof parsed.mcpUrl === 'string' && parseLoopbackMcpUrl(parsed.mcpUrl)
      ? parsed.mcpUrl
      : null;
  } catch {
    return null;
  }
}

export async function writePersistedEnvironment(filePath: string, mcpUrl: string): Promise<void> {
  const parsed = parseLoopbackMcpUrl(mcpUrl);
  if (!parsed) throw new Error('Working Memory environment URL must be loopback-only.');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ mcpUrl: parsed.toString() }, null, 2)}\n`, { mode: 0o600 });
}

const SOURCE_PRIORITY: Record<EnvironmentSource, number> = {
  production: 0,
  override: 1,
  sandbox: 2,
};

function fixedClient(mcpUrl: string): ControlPlaneClient {
  return new ControlPlaneClient({ resolveUrl: () => mcpUrl });
}

async function probeWorkingMemory(
  environment: DesktopEnvironment,
  createClient: (mcpUrl: string) => EnvironmentClient,
): Promise<boolean> {
  const client = createClient(environment.mcpUrl);
  try {
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    if (!names.has('wm-ping') || !names.has('wm-document-read')) return false;
    const ping = await client.callTool('wm-ping', {});
    return ping.ok && isWorkingMemoryPing(ping.result);
  } catch {
    return false;
  } finally {
    await client.dispose();
  }
}

function isWorkingMemoryPing(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const ping = result as { ok?: unknown; version?: unknown };
  return ping.ok === true && typeof ping.version === 'string' && ping.version.length > 0;
}

function candidatePortFiles(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): Array<{ filePath: string; source: EnvironmentSource }> {
  const productionHome = resolveControlPlaneHome({ platform, env, homedir, allowEnvOverride: false });
  const candidates: Array<{ filePath: string; source: EnvironmentSource }> = [
    { filePath: controlPlanePortFilePath(productionHome), source: 'production' },
  ];
  const override = env[CONTROL_PLANE_HOME_ENV]?.trim();
  if (override) {
    candidates.push({ filePath: controlPlanePortFilePath(override), source: 'override' });
  }
  candidates.push({
    filePath: controlPlanePortFilePath(join(homedir, 'wm-control-plane-sandbox')),
    source: 'sandbox',
  });
  return candidates;
}

export function parseLoopbackMcpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (url.protocol !== 'http:' || !loopback || url.pathname !== '/mcp' || url.search || url.hash) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return url;
  } catch {
    return null;
  }
}

export async function discoverDesktopEnvironments(
  dependencies: EnvironmentDiscoveryDependencies = {},
): Promise<DesktopEnvironment[]> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const homedir = dependencies.homedir ?? systemHomedir();
  const readTextFile = dependencies.readTextFile ?? ((filePath) => readFile(filePath, 'utf8'));
  const probe = dependencies.probe
    ?? ((environment: DesktopEnvironment) => probeWorkingMemory(
      environment,
      dependencies.createClient ?? fixedClient,
    ));
  const discovered = new Map<string, DesktopEnvironment>();
  const seen = new Set<string>();

  for (const candidate of candidatePortFiles(platform, env, homedir)) {
    let raw: string;
    try {
      raw = await readTextFile(candidate.filePath);
    } catch {
      continue;
    }
    const info = parsePortInfo(raw);
    if (!info) continue;
    const mcpUrl = `http://127.0.0.1:${info.port}/mcp`;
    if (!parseLoopbackMcpUrl(mcpUrl) || seen.has(mcpUrl)) continue;
    seen.add(mcpUrl);
    const environment: DesktopEnvironment = {
      id: mcpUrl,
      port: info.port,
      displayName: String(info.port),
      mcpUrl,
      source: candidate.source,
    };
    if (await probe(environment)) discovered.set(mcpUrl, environment);
  }

  return [...discovered.values()].sort((left, right) =>
    SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] || left.port - right.port);
}

export class DesktopEnvironmentManager<TClient extends EnvironmentClient = EnvironmentClient> {
  private readonly createClient: (mcpUrl: string) => TClient;
  private readonly readPersistedSelection: () => Promise<string | null>;
  private readonly writePersistedSelection: (mcpUrl: string) => Promise<void>;
  private environments: DesktopEnvironment[] = [];
  private selected: DesktopEnvironment | null = null;
  private client: TClient | null = null;

  constructor(private readonly dependencies: EnvironmentManagerDependencies = {}) {
    this.createClient = (dependencies.createClient ?? fixedClient) as (mcpUrl: string) => TClient;
    this.readPersistedSelection = dependencies.readPersistedSelection ?? (async () => null);
    this.writePersistedSelection = dependencies.writePersistedSelection ?? (async () => {});
  }

  get currentEnvironment(): DesktopEnvironment | null {
    return this.selected;
  }

  get availableEnvironments(): DesktopEnvironment[] {
    return [...this.environments];
  }

  get currentClient(): TClient {
    if (!this.client) throw new Error('No healthy Working Memory environment is selected.');
    return this.client;
  }

  async initialize(): Promise<DesktopEnvironment[]> {
    const environments = await this.discover();
    const persisted = parseLoopbackMcpUrl(await this.readPersistedSelection() ?? '')?.toString();
    const preferred = environments.find((environment) => environment.mcpUrl === persisted)
      ?? environments.find((environment) => environment.source === 'production')
      ?? environments[0];
    if (preferred) await this.select(preferred, false);
    return environments;
  }

  async discover(): Promise<DesktopEnvironment[]> {
    this.environments = await discoverDesktopEnvironments(this.dependencies);
    return [...this.environments];
  }

  async switchTo(mcpUrl: string, beforeSwitch?: () => Promise<void>): Promise<DesktopEnvironment> {
    const parsed = parseLoopbackMcpUrl(mcpUrl)?.toString();
    if (!parsed) throw new Error('Working Memory environment URL must be loopback-only.');
    const environments = await this.discover();
    const target = environments.find((environment) => environment.mcpUrl === parsed);
    if (!target) throw new Error('That Working Memory environment is no longer healthy.');
    if (this.selected?.mcpUrl !== target.mcpUrl) await beforeSwitch?.();
    await this.select(target, true);
    return target;
  }

  async dispose(): Promise<void> {
    const previous = this.client;
    this.client = null;
    this.selected = null;
    await previous?.dispose();
  }

  private async select(environment: DesktopEnvironment, persist: boolean): Promise<void> {
    if (this.selected?.mcpUrl === environment.mcpUrl && this.client) return;
    if (persist) await this.writePersistedSelection(environment.mcpUrl);
    const previous = this.client;
    this.client = this.createClient(environment.mcpUrl);
    this.selected = environment;
    await previous?.dispose();
  }
}