import { createHash } from 'node:crypto';
import type { DesktopResourceKind } from '../shared/contracts';

export function resourceDragFilename(
  kind: DesktopResourceKind,
  identifier: string,
  label: string,
): string {
  const safeName = (label.trim() || identifier)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'working-memory-context';
  const identity = createHash('sha256')
    .update(`${kind}:${identifier}`)
    .digest('hex')
    .slice(0, 10);
  return `${safeName}-${identity}.md`;
}
