const WORKSTREAM_COLOR_COUNT = 15;

export function colorIndexForId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % WORKSTREAM_COLOR_COUNT;
}

export function workstreamColorClass(id: string): string {
  return `ws-card-color-${colorIndexForId(id)}`;
}