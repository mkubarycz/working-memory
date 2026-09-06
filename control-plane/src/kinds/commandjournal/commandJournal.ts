import type { DocumentEnvelope } from '../../store.js';
import type { CommandJournalSpec } from './index.js';

export interface ICommandJournal extends CommandJournalSpec {
  id: string;
  resourceVersion: number;
  createdAt: number;
  updatedAt: number;
}

export class CommandJournal implements ICommandJournal {
  id: string;
  resourceVersion: number;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 2;
  status: CommandJournalSpec['status'];
  startedAt: number;
  completedAt?: number;
  provider: CommandJournalSpec['provider'];
  request: CommandJournalSpec['request'];
  primaryScope: CommandJournalSpec['primaryScope'];
  entityRefs: CommandJournalSpec['entityRefs'];
  events: CommandJournalSpec['events'];
  completion?: CommandJournalSpec['completion'];

  constructor(envelope: DocumentEnvelope) {
    const spec = envelope.spec as CommandJournalSpec;
    this.id = envelope.metadata.id;
    this.resourceVersion = envelope.metadata.resourceVersion;
    this.createdAt = envelope.metadata.createdAt;
    this.updatedAt = envelope.metadata.updatedAt;
    this.schemaVersion = spec.schemaVersion;
    this.status = spec.status;
    this.startedAt = spec.startedAt;
    this.completedAt = spec.completedAt;
    this.provider = spec.provider;
    this.request = spec.request;
    this.primaryScope = spec.primaryScope;
    this.entityRefs = spec.entityRefs;
    this.events = spec.events;
    this.completion = spec.completion;
  }
}