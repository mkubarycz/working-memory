import { describe, it, expect, beforeEach } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { clearKinds, getKind, listKinds } from '../src/kinds/registry';

describe('kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('discovers the Topic kind from the kinds folder and registers it', async () => {
    // Default dir = the loader module's own folder (control-plane/src/kinds under
    // vitest; out/control-plane/kinds in the compiled daemon). The scan finds
    // topic.kind.ts / topic.kind.js by convention — no central list.
    const registered = await loadKinds();
    expect(registered).toContain('Topic');
    expect(listKinds()).toContain('Topic');
    expect(getKind('Topic')).toBeTruthy();
  });

  it('returns [] for a nonexistent directory without throwing', async () => {
    const registered = await loadKinds('/no/such/kinds/dir/exists');
    expect(registered).toEqual([]);
  });
});
