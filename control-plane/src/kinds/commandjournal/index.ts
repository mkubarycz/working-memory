import type { McpServer } from '@modelcontextprotocol/server';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { registerWsCommandJournalOperations } from './operations.js';
import { registerWsCommandJournalRead } from './read.js';

import { COMMAND_JOURNAL_KIND, commandJournalSpec } from './schema.js';
export * from './schema.js';

const commandJournal: KindModule = {
  name: COMMAND_JOURNAL_KIND,
  descriptor: {
    extends: Base,
    spec: commandJournalSpec,
    fts: (row) => `${row.spec?.request?.userText ?? ''}\n${row.spec?.completion?.finalAssistantText ?? ''}`,
  },
  registerApi: registerCommandJournalApi,
};

function registerCommandJournalApi(server: McpServer, store: Store): void {
  registerWsCommandJournalRead(server, store);
  registerWsCommandJournalOperations(server, store);
}

export default commandJournal;