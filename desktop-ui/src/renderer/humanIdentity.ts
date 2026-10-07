export function humanInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'FB';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)?.[0] ?? ''}`.toUpperCase();
}
