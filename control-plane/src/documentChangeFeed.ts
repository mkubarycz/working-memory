import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DocumentChange, Store } from './store.js';

interface DocumentChanges {
  resourceVersion: number;
  reset: boolean;
  changes: DocumentChange[];
}

export function createDocumentChangeFeed(store: Store) {
  let version = store.getResourceVersion();
  const history: DocumentChange[] = [];
  const waiting = new Set<() => void>();
  const unsubscribe = store.onDocumentsChanged((changes) => {
    history.push(...changes);
    if (history.length > 256) history.splice(0, history.length - 256);
    version = changes.at(-1)!.resourceVersion;
    for (const respond of [...waiting]) respond();
  });

  function snapshot(since: number | undefined): DocumentChanges {
    const reset = since === undefined || since > version
      || (since < version && since < (history[0]?.resourceVersion ?? version + 1) - 1);
    return {
      resourceVersion: version,
      reset,
      changes: reset ? [] : history.filter((change) => change.resourceVersion > since!),
    };
  }

  return {
    handle(_req: IncomingMessage, res: ServerResponse, url: URL, authorized: () => boolean = () => true): void {
      const raw = url.searchParams.get('since');
      const since = raw === null ? undefined : Number(raw);
      if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(since))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'since must be a non-negative integer resource version.' }));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        waiting.delete(respond);
        res.removeListener('close', cleanup);
      };
      const respond = () => {
        cleanup();
        if (!authorized()) {
          res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'instance_authentication_required',
            message: 'Your credential expired or was revoked. Sign in again, or request an owner-approved refresh through /identity/v1/mcp.' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(snapshot(since)));
      };
      if (since !== version) {
        respond();
        return;
      }
      waiting.add(respond);
      res.once('close', cleanup);
      timer = setTimeout(respond, 25_000);
      timer.unref();
    },
    close(): void {
      unsubscribe();
      for (const respond of [...waiting]) respond();
    },
  };
}
