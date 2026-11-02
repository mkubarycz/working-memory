export function formatDocumentTimestamp(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : '—';
}

export function formatRelativeDocumentTime(seconds: number, now = Date.now()): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 8_640_000_000_000 || !Number.isFinite(now)) {
    throw new Error('Relative time requires a valid Unix-seconds timestamp and current time in milliseconds.');
  }
  const difference = seconds * 1000 - now;
  if (difference === 0) return 'now';
  const minutes = Math.floor(Math.abs(difference) / 60_000);
  const unit = (amount: number, name: string) => `${amount} ${name}${amount === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const duration = minutes === 0 ? 'less than a minute' : minutes < 60 ? unit(minutes, 'minute')
    : hours < 24 ? `${unit(hours, 'hour')}${minutes % 60 ? ` ${unit(minutes % 60, 'minute')}` : ''}`
    : `${unit(Math.floor(hours / 24), 'day')}${hours % 24 ? ` ${unit(hours % 24, 'hour')}` : ''}`;
  return difference > 0 ? `in ${duration}` : `${duration} ago`;
}
