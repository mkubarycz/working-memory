import type { ContainerAppDefinition } from '../shared/contracts';
import {
  isSafeMentionStart,
  isSafeMentionTerminator,
  normalizeAppAlias,
} from '../shared/mentionSyntax';

export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export interface MentionReplacement {
  value: string;
  caret: number;
}

export type MentionKeyAction =
  | { type: 'navigate'; index: number }
  | { type: 'select'; index: number }
  | { type: 'dismiss' }
  | { type: 'send' }
  | { type: 'none' };

export function mentionTokenAtCaret(
  value: string,
  caret: number,
  definitions: readonly Pick<ContainerAppDefinition, 'id' | 'displayName'>[] = [],
): MentionToken | null {
  const cursor = Math.max(0, Math.min(caret, value.length));
  let at = cursor - 1;
  while (at >= 0 && /[A-Za-z0-9_ \t-]/.test(value[at])) at -= 1;
  if (at < 0 || value[at] !== '@' || !isSafeMentionStart(value, at)) return null;

  const query = value.slice(at + 1, cursor);
  if (!/^[A-Za-z0-9_-]*(?:[ \t]+[A-Za-z0-9_-]*)*$/.test(query)) return null;
  const aliases = new Set(definitions.flatMap((definition) => [
    normalizeAppAlias(definition.id),
    normalizeAppAlias(definition.displayName),
  ]));
  for (const whitespace of query.matchAll(/[ \t]+/g)) {
    const aliasEnd = whitespace.index;
    if (
      aliases.has(normalizeAppAlias(query.slice(0, aliasEnd)))
      && isSafeMentionTerminator(value, at + 1 + aliasEnd)
    ) return null;
  }

  let end = cursor;
  while (end < value.length && /[A-Za-z0-9_-]/.test(value[end])) end += 1;
  return { start: at, end, query };
}

export function filterMentionApps<T extends Pick<ContainerAppDefinition, 'id' | 'displayName'>>(
  definitions: readonly T[],
  query: string,
): T[] {
  const normalized = normalizeAppAlias(query);
  if (!normalized) return [...definitions];
  return definitions.filter((definition) =>
    normalizeAppAlias(definition.id).includes(normalized)
    || normalizeAppAlias(definition.displayName).includes(normalized));
}

export function replaceMentionToken(value: string, token: MentionToken, appId: string): MentionReplacement {
  const insertion = `@${appId} `;
  return {
    value: `${value.slice(0, token.start)}${insertion}${value.slice(token.end)}`,
    caret: token.start + insertion.length,
  };
}

export function mentionKeyAction(
  key: string,
  open: boolean,
  optionCount: number,
  activeIndex: number,
): MentionKeyAction {
  if (!open) return key === 'Enter' ? { type: 'send' } : { type: 'none' };
  if (key === 'Escape') return { type: 'dismiss' };
  if (key === 'ArrowDown' && optionCount) {
    return { type: 'navigate', index: (activeIndex + 1) % optionCount };
  }
  if (key === 'ArrowUp' && optionCount) {
    return { type: 'navigate', index: (activeIndex - 1 + optionCount) % optionCount };
  }
  if ((key === 'Enter' || key === 'Tab') && optionCount) {
    return { type: 'select', index: Math.min(Math.max(activeIndex, 0), optionCount - 1) };
  }
  return { type: 'none' };
}

export function mentionKeyEventAction(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  open: boolean,
  optionCount: number,
  activeIndex: number,
): MentionKeyAction {
  if (event.key === 'Enter' && event.shiftKey) return { type: 'none' };
  const action = mentionKeyAction(event.key, open, optionCount, activeIndex);
  if (action.type !== 'none' || (open && (event.key === 'Enter' || event.key === 'Tab'))) {
    event.preventDefault();
  }
  return action;
}
