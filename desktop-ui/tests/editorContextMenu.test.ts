import { describe, expect, it, vi } from 'vitest';
import { spellingMenuItems } from '../src/main/editorContextMenu';

describe('native editor context menu', () => {
  const params = { isEditable: true, misspelledWord: 'occurrance', dictionarySuggestions: ['occurrence', 'occurrences'] };

  function contents() {
    return {
      replaceMisspelling: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn() },
    };
  }

  it('offers spelling replacements and adds the actual misspelled word to the dictionary', () => {
    const target = contents();
    const items = spellingMenuItems(params, target);
    expect(items.slice(0, 3).map(item => item.label)).toEqual(['occurrence', 'occurrences', 'Add to Dictionary']);
    const click = (index: number) => items[index].click?.(
      {} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as Electron.KeyboardEvent,
    );
    click(0);
    expect(target.replaceMisspelling).toHaveBeenCalledWith('occurrence');
    click(2);
    expect(target.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('occurrance');
    expect(items.map(item => item.role)).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'undo', 'redo', 'selectAll']));
  });

  it('offers dictionary and editing actions even without suggestions', () => {
    const items = spellingMenuItems({ ...params, dictionarySuggestions: [] }, contents());
    expect(items[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false });
    expect(items[1].label).toBe('Add to Dictionary');
  });

  it('keeps ordinary editing actions and leaves non-editable image menus alone', () => {
    const target = contents();
    expect(spellingMenuItems({ ...params, misspelledWord: '' }, target).some(item => item.role === 'paste')).toBe(true);
    expect(spellingMenuItems({ ...params, isEditable: false }, target)).toEqual([]);
  });
});
