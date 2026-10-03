import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistry } from '../../src/app/registry.js';
import { ResourceService } from '../../src/framework/service.js';
import { ResourceStore } from '../../src/framework/store.js';

test('runs generic CRUD with compare-and-swap and transaction correlation', () => {
  const store = new ResourceStore(':memory:');
  const service = new ResourceService(createRegistry(), store);
  try {
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const created = service.create({
      kind: 'Note',
      spec: { title: 'First note' },
      transactionId,
      actor: 'test',
    });
    assert.equal(created.transactionId, transactionId);
    assert.equal(created.result.kind, 'Note');
    assert.equal(created.result.metadata.resourceVersion, 1);
    assert.deepEqual(created.result.status, { state: 'active' });

    const queried = service.query('Note', { title: 'First note' });
    assert.equal(queried.result.length, 1);

    const updated = service.update({
      kind: 'Note',
      id: created.result.metadata.id,
      expectedResourceVersion: 1,
      spec: { title: 'Updated note' },
      status: { state: 'archived' },
      relationships: { relatedNotes: [] },
    });
    assert.equal(updated.result.metadata.resourceVersion, 2);
    assert.throws(() => service.update({
      kind: 'Note',
      id: created.result.metadata.id,
      expectedResourceVersion: 1,
      spec: updated.result.spec,
      status: updated.result.status,
      relationships: updated.result.relationships,
    }), /conflict/);
  } finally {
    store.close();
  }
});

test('commits resource, audit event, and domain event atomically', () => {
  const store = new ResourceStore(':memory:');
  const service = new ResourceService(createRegistry(), store);
  try {
    const created = service.create({
      kind: 'Note',
      spec: { title: 'Atomic note' },
      transactionId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM resources').get()!.count, 1);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM audit_events').get()!.count, 1);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM domain_events').get()!.count, 1);
    assert.equal(
      store.database.prepare('SELECT transaction_id FROM audit_events').get()!.transaction_id,
      created.transactionId,
    );

    service.delete({
      kind: 'Note',
      id: created.result.metadata.id,
      expectedResourceVersion: 1,
    });
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM resources').get()!.count, 0);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM audit_events').get()!.count, 2);
    assert.equal(store.database.prepare('SELECT count(*) AS count FROM domain_events').get()!.count, 2);
  } finally {
    store.close();
  }
});
