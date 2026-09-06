import { describe, it, expect, beforeEach } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { clearKinds, getKind, listKinds } from '../src/kinds/registry';

describe('kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('discovers each kind subfolder from the kinds folder and registers it', async () => {
    // Default dir = the loader module's own folder (control-plane/src/kinds under
    // vitest; out/control-plane/kinds in the compiled daemon). The scan walks each
    // SUBFOLDER and loads its `index.ts` / `index.js` by convention — no central
    // list. Exactly the nine kinds register.
    const registered = await loadKinds();
    expect(registered).toEqual(
      expect.arrayContaining([
        'Topic',
        'Workstream',
        'TopicType',
        'Alert',
        'NaniteTemplate',
        'Nanite',
        'NaniteJournal',
        'Config',
        'CommandJournal',
      ]),
    );
    expect(registered).toHaveLength(9);
    expect(listKinds()).toContain('Topic');
    expect(getKind('Topic')).toBeTruthy();
  });

  it('returns [] for a nonexistent directory without throwing', async () => {
    const registered = await loadKinds('/no/such/kinds/dir/exists');
    expect(registered).toEqual([]);
  });
});
