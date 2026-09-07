export interface DocumentSaveQueueOptions<Patch extends object, Result> {
  delayMs: number;
  save(key: string, patch: Partial<Patch>): Promise<Result>;
  onPending?(key: string): void;
  onSaving?(key: string): void;
  onSaved?(key: string, result: Result): void;
  onError?(key: string, error: unknown): void;
}

interface SaveEntry<Patch extends object> {
  patch: Partial<Patch>;
  timer: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<void>;
  active: boolean;
  error: unknown;
}

export interface DocumentSaveQueue<Patch extends object> {
  schedule(key: string, patch: Partial<Patch>): void;
  flushAll(): Promise<void>;
  clear(): void;
}

export function createDocumentSaveQueue<Patch extends object, Result>(
  options: DocumentSaveQueueOptions<Patch, Result>,
): DocumentSaveQueue<Patch> {
  const entries = new Map<string, SaveEntry<Patch>>();

  const flush = (key: string, entry: SaveEntry<Patch>) => {
    entry.timer = undefined;
    const operation = entry.chain
      .catch(() => undefined)
      .then(async () => {
        if (!entry.active) return;
        const patch = entry.patch;
        entry.patch = {};
        entry.error = undefined;
        options.onSaving?.(key);
        try {
          const result = await options.save(key, patch);
          if (entry.active && entry.chain === operation && entry.timer === undefined &&
            Object.keys(entry.patch).length === 0) options.onSaved?.(key, result);
        } catch (error) {
          if (!entry.active) return;
          entry.patch = { ...patch, ...entry.patch };
          entry.error = error;
          if (entry.chain === operation && entry.timer === undefined) options.onError?.(key, error);
          throw error;
        }
      })
      .finally(() => {
        if (entry.active && entry.chain === operation && entry.timer === undefined &&
          entry.error === undefined && Object.keys(entry.patch).length === 0) entries.delete(key);
      });
    entry.chain = operation;
    void operation.catch(() => undefined);
  };

  return {
    schedule(key, patch) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { patch: {}, timer: undefined, chain: Promise.resolve(), active: true, error: undefined };
        entries.set(key, entry);
      }
      Object.assign(entry.patch, patch);
      entry.error = undefined;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      options.onPending?.(key);
      entry.timer = setTimeout(() => flush(key, entry), options.delayMs);
    },
    async flushAll() {
      while (entries.size > 0) {
        for (const [key, entry] of entries) {
          if (entry.timer !== undefined) {
            clearTimeout(entry.timer);
            flush(key, entry);
          }
        }
        const snapshot = [...entries.values()].map((entry) => ({ entry, chain: entry.chain }));
        await Promise.allSettled(snapshot.map(({ chain }) => chain));
        for (const { entry, chain } of snapshot) {
          if (!entry.active || entry.chain !== chain || entry.timer !== undefined) continue;
          if (entry.error !== undefined) throw entry.error;
        }
      }
    },
    clear() {
      for (const entry of entries.values()) {
        entry.active = false;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
}
