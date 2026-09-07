const DRAFT_KEY_PREFIX = 'working-memory.desktop.composer-draft:';

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function composerDraftKey(environmentId: string | null | undefined): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(environmentId ?? 'unselected')}`;
}

export function readComposerDraft(storage: DraftStorage, environmentId: string | null | undefined): string {
  return storage.getItem(composerDraftKey(environmentId)) ?? '';
}

export function writeComposerDraft(
  storage: DraftStorage,
  environmentId: string | null | undefined,
  value: string,
): void {
  const key = composerDraftKey(environmentId);
  if (value.length === 0) storage.removeItem(key);
  else storage.setItem(key, value);
}