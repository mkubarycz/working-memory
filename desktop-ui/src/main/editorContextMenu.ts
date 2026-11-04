import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';

export function spellingMenuItems(
  params: Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions'>,
  contents: Pick<WebContents, 'replaceMisspelling'> & {
    session: Pick<WebContents['session'], 'addWordToSpellCheckerDictionary'>;
  },
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return [];
  const items: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    items.push(...(params.dictionarySuggestions.length
      ? params.dictionarySuggestions.map(suggestion => ({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        }))
      : [{ label: 'No spelling suggestions', enabled: false }]));
    items.push({
      label: 'Add to Dictionary',
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    }, { type: 'separator' });
  }
  items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  return items;
}
