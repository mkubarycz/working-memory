/**
 * The in-process kind registry.
 *
 * `registerKind(name, descriptor)` resolves the descriptor's `extends` chain
 * (shallow — one Base) by composing its `spec`/`status` ON TOP of the parent
 * (Zod object composition) and stores the result. Names are **case-sensitive**
 * (`'Topic'` ≠ `'topic'`), which is what lets registered kinds coexist with the
 * legacy free-form lowercase kinds.
 *
 * The composed Zod schemas ARE the validation: `validateSpec` parses caller
 * input against the kind's `spec` (surfacing readable ZodError issues on
 * failure), and `defaultStatus` yields the kind's controller-owned status
 * default (Base → `{}`).
 */

import { z, type ZodTypeAny, type ZodError } from 'zod';
import { Base, type KindDescriptor, type KindModule } from './base.js';

/** Version-stable alias for Zod's issue list (name differs across zod majors). */
type ZodIssues = ZodError['issues'];

/** A registered kind: the raw descriptor plus its composed spec/status schemas. */
export interface RegisteredKind {
  name: string;
  descriptor: KindDescriptor;
  /** `parent.spec` composed with the descriptor's own `spec`. */
  spec: ZodTypeAny;
  /** `parent.status` composed with the descriptor's own `status` (if any). */
  status: ZodTypeAny;
  /**
   * The kind's OPTIONAL domain-API registrar (its `ws-*` / `topic-*` / … MCP
   * tools). Retained here so the server can iterate every registered kind and
   * wire up its namespaced API alongside the generic CRUD. `undefined` for
   * kinds that contribute only the generic surface.
   */
  registerApi?: KindModule['registerApi'];
}

/** Thrown by `validateSpec` when caller input fails the kind's `spec` schema. */
export class KindValidationError extends Error {
  readonly issues: ZodIssues;
  constructor(message: string, issues: ZodIssues) {
    super(message);
    this.name = 'KindValidationError';
    this.issues = issues;
  }
}

const registry = new Map<string, RegisteredKind>();

function asObject(schema: ZodTypeAny): z.ZodObject | null {
  return schema instanceof z.ZodObject ? schema : null;
}

/**
 * Whether a Zod object schema is `.strict()` (rejects unknown keys). In Zod 4
 * strictness is modelled as a `never` catchall on the object's def; a loose
 * ("strip") object has no catchall. We preserve this across composition so a
 * strict child spec (e.g. Topic) doesn't silently loosen when extended onto
 * Base.
 */
function isStrictObject(o: z.ZodObject): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (o as any).def;
  return def?.catchall?.def?.type === 'never';
}

/**
 * Shallow Zod composition: when both parent and own schemas are objects, extend
 * the parent's shape with the own shape (own wins on key collisions), and
 * PRESERVE the own schema's unknown-key handling — `.extend()` resets the
 * catchall to "strip", so a strict `own` must be re-marked `.strict()`. If
 * `own` is omitted, inherit the parent outright; non-object schemas let `own`
 * win.
 */
function compose(parent: ZodTypeAny, own: ZodTypeAny | undefined): ZodTypeAny {
  if (!own) {
    return parent;
  }
  const p = asObject(parent);
  const o = asObject(own);
  if (p && o) {
    const merged = p.extend(o.shape);
    return isStrictObject(o) ? merged.strict() : merged;
  }
  return own;
}

/** Register (or overwrite) a kind, composing its schemas on top of Base. */
export function registerKind(
  name: string,
  descriptor: KindDescriptor,
  registerApi?: KindModule['registerApi'],
): void {
  const parent = descriptor.extends ?? Base;
  const spec = compose(parent.spec, descriptor.spec);
  const status = compose(parent.status ?? Base.status ?? z.object({}), descriptor.status);
  registry.set(name, { name, descriptor, spec, status, registerApi });
}

/** Look up a registered kind by (case-sensitive) name. */
export function getKind(name: string): RegisteredKind | undefined {
  return registry.get(name);
}

/** All registered kind names, in registration order. */
export function listKinds(): string[] {
  return [...registry.keys()];
}

/**
 * Every registered kind that exposes a domain API, as `{ name, registerApi }`
 * (registration order). Kinds without a `registerApi` hook are omitted, so the
 * server can iterate this list and call each registrar unconditionally.
 */
export function listKindApis(): {
  name: string;
  registerApi: NonNullable<KindModule['registerApi']>;
}[] {
  const apis: { name: string; registerApi: NonNullable<KindModule['registerApi']> }[] = [];
  for (const kind of registry.values()) {
    if (kind.registerApi) {
      apis.push({ name: kind.name, registerApi: kind.registerApi });
    }
  }
  return apis;
}

/**
 * Top-level field names of a kind's composed `spec` schema. Lets an agent
 * introspect exactly which fields a kind allows (its `spec` is `.strict()`, so
 * anything not in this list is rejected). Returns `[]` for unknown kinds or a
 * non-object spec.
 */
export function specFields(name: string): string[] {
  const kind = registry.get(name);
  if (!kind) {
    return [];
  }
  const o = asObject(kind.spec);
  return o ? Object.keys(o.shape) : [];
}

/** Clear the registry (test helper). */
export function clearKinds(): void {
  registry.clear();
}

/**
 * Validate + normalize caller `spec` input against the kind's composed schema.
 * Returns the parsed spec (with defaults applied); throws `KindValidationError`
 * (readable, issue-preserving) on failure. Throws a plain error for unknown
 * kinds — callers should gate on `getKind` first.
 */
export function validateSpec(name: string, specInput: unknown): Record<string, unknown> {
  const kind = registry.get(name);
  if (!kind) {
    throw new Error(`Unknown kind: ${name}`);
  }
  const result = kind.spec.safeParse(specInput ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new KindValidationError(
      `Invalid spec for kind "${name}": ${detail}`,
      result.error.issues,
    );
  }
  return result.data as Record<string, unknown>;
}

/** The kind's controller-owned status default (Base → `{}`). */
export function defaultStatus(name: string): Record<string, unknown> {
  const kind = registry.get(name);
  if (!kind) {
    throw new Error(`Unknown kind: ${name}`);
  }
  const result = kind.status.safeParse({});
  return (result.success ? result.data : {}) as Record<string, unknown>;
}
