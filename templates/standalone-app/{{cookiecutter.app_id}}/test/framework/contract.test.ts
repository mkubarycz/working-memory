import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistry } from '../../src/app/registry.js';
import { applicationContract } from '../../src/contract.js';

test('publishes the approved envelope and Zod-derived app resource schemas', () => {
  const contract = applicationContract(createRegistry());
  assert.deepEqual(
    Object.keys(contract.envelope),
    ['kind', 'metadata', 'spec', 'status', 'relationships'],
  );
  assert.equal(contract.application.dataOwnership, 'application');
  assert.equal(contract.resources[0].kind, 'Note');
  assert.equal(contract.resources[0].schema.spec.type, 'object');
  assert.match(contract.resources[0].businessRules[0], /cannot relate to itself/);
});
