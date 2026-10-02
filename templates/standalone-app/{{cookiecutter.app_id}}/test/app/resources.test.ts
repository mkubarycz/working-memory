import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistry } from '../../src/app/registry.js';
import { ResourceService } from '../../src/framework/service.js';
import { ResourceStore } from '../../src/framework/store.js';

test('starter Note relationships refer to existing notes', () => {
  const store = new ResourceStore(':memory:');
  const service = new ResourceService(createRegistry(), store);
  try {
    assert.throws(() => service.create({
      kind: 'Note',
      spec: { title: 'Broken relationship' },
      relationships: { relatedNotes: [crypto.randomUUID()] },
    }), /was not found/);
    assert.equal(store.query('Note').length, 0);
  } finally {
    store.close();
  }
});
