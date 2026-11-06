import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';

export function watchSpellingDictionaryFailures(
  contents: {
    session: {
      on(event: 'spellcheck-dictionary-download-failure', listener: (event: Electron.Event, language: string) => void): unknown;
      removeListener(event: 'spellcheck-dictionary-download-failure', listener: (event: Electron.Event, language: string) => void): unknown;
    };
    once(event: 'destroyed', listener: () => void): unknown;
  },
  report: (language: string) => void,
): void {
  const session = contents.session;
  const failure = (_event: Electron.Event, language: string) => report(language);
  session.on('spellcheck-dictionary-download-failure', failure);
  contents.once('destroyed', () => session.removeListener('spellcheck-dictionary-download-failure', failure));
}

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
