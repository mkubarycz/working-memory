interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function startVisiblePolling(refresh: () => Promise<void>, intervalMs: number,
  visibility: VisibilitySource = document): () => void {
  let stopped = false, running = false, refreshOnReturn = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const poll = async (): Promise<void> => {
    if (stopped || visibility.hidden) return;
    if (running) { refreshOnReturn = true; return; }
    running = true;
    try { await refresh(); }
    catch (error) { console.error('[diagnostics] Automatic refresh failed:', error); }
    finally {
      running = false;
      if (!stopped && !visibility.hidden) {
        if (refreshOnReturn) { refreshOnReturn = false; void poll(); }
        else timer = setTimeout(() => { timer = undefined; void poll(); }, intervalMs);
      }
    }
  };
  const visible = () => {
    clearTimer();
    refreshOnReturn = false;
    if (!visibility.hidden) void poll();
  };
  visibility.addEventListener('visibilitychange', visible);
  visible();
  return () => {
    stopped = true;
    clearTimer();
    visibility.removeEventListener('visibilitychange', visible);
  };
}
