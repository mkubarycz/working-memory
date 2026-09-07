export interface QuitEvent {
  preventDefault(): void;
}

export interface GracefulShutdownOptions {
  resetAgent(): Promise<void>;
  disposeEnvironment(): Promise<void>;
  quit(): void;
  onError?(error: unknown): void;
  timeoutMs?: number;
}

export function createGracefulShutdown(options: GracefulShutdownOptions): (event: QuitEvent) => Promise<void> | void {
  let running = false;
  let completed = false;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const bounded = async (label: string, operation: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return (event) => {
    if (completed) return;
    event.preventDefault();
    if (running) return;
    running = true;
    return (async () => {
      try {
        await bounded('Agent reset', options.resetAgent());
      } catch (error) {
        options.onError?.(error);
      }
      try {
        await bounded('Environment disposal', options.disposeEnvironment());
      } catch (error) {
        options.onError?.(error);
      } finally {
        completed = true;
        options.quit();
      }
    })();
  };
}
