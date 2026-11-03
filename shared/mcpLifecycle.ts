export const SESSION_TERMINATION_TIMEOUT_MS = 2000;

/** DELETE must survive cancellation of the connection it is reclaiming. */
export function sessionLifecycleFetch(base: typeof fetch, lifetime: AbortSignal): typeof fetch {
  return (input, init = {}) => {
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET') return Promise.resolve(new Response(null, { status: 405 }));
    const signal = method === 'DELETE'
      ? AbortSignal.timeout(SESSION_TERMINATION_TIMEOUT_MS)
      : AbortSignal.any([lifetime, ...(init.signal ? [init.signal] : [])]);
    return base(input, { ...init, signal });
  };
}

export function staleSessionRejected(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (
    error.code === 404 && error.message.includes('Session not found or expired.')
    || error.code === 400 && error.message.includes('"message":"Bad Request: no valid session ID"')
  );
}

type SessionClient = { close(): Promise<void> };
type SessionTransport = { terminateSession(): Promise<void>; close(): Promise<void> };
const closing = new WeakMap<SessionClient, Promise<void>>();

export function closeMcpSession(
  client: SessionClient | null,
  transport: SessionTransport | null,
  onError: (error: unknown) => void,
): Promise<void> {
  if (client) {
    const pending = closing.get(client);
    if (pending) return pending;
  }
  const completion = (async () => {
    try { await transport?.terminateSession(); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 404)) onError(error);
    } finally {
      try { await client?.close(); }
      catch (error) { onError(error); }
      try { await transport?.close(); }
      catch (error) { onError(error); }
    }
  })();
  if (client) closing.set(client, completion);
  return completion;
}
