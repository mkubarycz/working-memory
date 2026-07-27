import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { registerKind, clearKinds, listKindApis } from '../src/kinds/registry';

/**
 * The `registerApi` plugin mechanism at the registry level: a kind may OPTIONALLY
 * carry a `registerApi` hook alongside its descriptor. `listKindApis()` is what
 * the server iterates to wire each kind's namespaced domain API, so it must
 * surface exactly the kinds that define the hook — and a descriptor-only kind
 * must never break that iteration.
 */
describe('kind registerApi registry mechanism', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('omits descriptor-only kinds and retains kinds that define registerApi', () => {
    // A kind with no registerApi contributes nothing to listKindApis (no break).
    registerKind('DescriptorOnly', { spec: z.object({}) });
    expect(listKindApis()).toEqual([]);

    // A kind WITH a registerApi is surfaced by name.
    const calls: string[] = [];
    registerKind('WithApi', { spec: z.object({}) }, () => {
      calls.push('registered');
    });
    const apis = listKindApis();
    expect(apis.map((a) => a.name)).toEqual(['WithApi']);

    // The retained fn is exactly what the server invokes per MCP session.
    apis[0]?.registerApi({} as never, {} as never);
    expect(calls).toEqual(['registered']);
  });

  it('preserves registration order across a mix of descriptor-only and api kinds', () => {
    registerKind('A', { spec: z.object({}) }, () => {});
    registerKind('B', { spec: z.object({}) });
    registerKind('C', { spec: z.object({}) }, () => {});
    expect(listKindApis().map((a) => a.name)).toEqual(['A', 'C']);
  });
});
