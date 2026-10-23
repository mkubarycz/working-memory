import { StreamableHTTPClientTransport as Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ControlPlaneClient as DataClient, type ControlPlaneClientOptions } from '../shared/controlPlaneClient';
import { startServer as start, type StartServerOptions, type RunningServer } from '../control-plane/src/server';
import { openStore } from '../control-plane/src/store';
import { InstanceIdentity } from '../control-plane/src/instanceIdentity';

export * from '../shared/controlPlaneClient';
export type { RunningServer } from '../control-plane/src/server';
const tokens = new Map<string, string>();
const password = 'test-only instance owner password';

function headers(url: string | URL, original?: HeadersInit): Headers {
  const result = new Headers(original);
  const token = tokens.get(new URL(url).origin);
  if (token && !result.has('Authorization')) result.set('Authorization', `Bearer ${token}`);
  return result;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const store = options.store ?? openStore(':memory:');
  const identity = new InstanceIdentity(store.db);
  const session = identity.configured() ? await identity.login({ password }) : await identity.initialize(password);
  const server = await start({ ...options, store });
  tokens.set(server.url, session.token);
  return {
    ...server,
    async close() {
      await server.close();
      tokens.delete(server.url);
      if (!options.store) store.close();
    },
  };
}

export class StreamableHTTPClientTransport extends Transport {
  constructor(url: URL, options: ConstructorParameters<typeof Transport>[1] = {}) {
    super(url, { ...options, requestInit: {
      ...options.requestInit, headers: headers(url, options.requestInit?.headers),
    } });
  }
}

export class ControlPlaneClient extends DataClient {
  constructor(options: ControlPlaneClientOptions = {}) {
    super({ ...options, getToken: options.getToken ?? (url => tokens.get(new URL(url).origin) ?? null) });
  }
}

export const fetch: typeof globalThis.fetch = (input, init = {}) => {
  const url = input instanceof Request ? input.url : input;
  return globalThis.fetch(input, { ...init, headers: headers(url, init.headers ?? (input instanceof Request ? input.headers : undefined)) });
};
