export function formatDocumentTimestamp(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : '—';
}
