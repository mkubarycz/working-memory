export function normalizeAppAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '-');
}

export function isSafeMentionStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{\\"',;:!?]/.test(text[index - 1]);
}

export function isSafeMentionTerminator(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const next = text[index];
  if (/\s/.test(next) || /[,;:!?()[\]{}]/.test(next)) return true;
  return next === '.' && (index + 1 >= text.length || /\s/.test(text[index + 1]));
}
