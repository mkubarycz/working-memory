import { describe, expect, it } from 'vitest';
import {
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
  type DraftStorage,
} from '../src/renderer/composerDraft';

function memoryStorage(): DraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe('desktop composer draft persistence', () => {
  it('round-trips unsent text independently for each environment', () => {
    const storage = memoryStorage();
    writeComposerDraft(storage, 'http://127.0.0.1:7717/mcp', 'production draft');
    writeComposerDraft(storage, 'http://127.0.0.1:60860/mcp', 'sandbox draft');

    expect(readComposerDraft(storage, 'http://127.0.0.1:7717/mcp')).toBe('production draft');
    expect(readComposerDraft(storage, 'http://127.0.0.1:60860/mcp')).toBe('sandbox draft');
  });

  it('removes the persisted draft when submission clears the composer', () => {
    const storage = memoryStorage();
    const environment = 'http://127.0.0.1:7717/mcp';
    writeComposerDraft(storage, environment, 'submit me');
    writeComposerDraft(storage, environment, '');

    expect(readComposerDraft(storage, environment)).toBe('');
    expect(composerDraftKey(environment)).toContain(encodeURIComponent(environment));
  });
});