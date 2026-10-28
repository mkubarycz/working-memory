import { z } from 'zod';

const required = z.boolean().default(false);
const parameter = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'), required, maxLength: z.number().int().min(1).max(4096).default(256),
    enum: z.array(z.string().max(4096)).min(1).max(50).optional(),
  }).strict(),
  z.object({
    type: z.literal('integer'), required,
    minimum: z.number().int().min(-1_000_000).max(1_000_000),
    maximum: z.number().int().min(-1_000_000).max(1_000_000),
  }).strict().refine(value => value.minimum <= value.maximum, 'Invalid integer bounds'),
  z.object({ type: z.literal('boolean'), required }).strict(),
]);

export const scriptParametersSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
    .refine(key => !['constructor', 'prototype', '__proto__'].includes(key)),
  parameter,
).refine(value => Object.keys(value).length <= 20, 'At most 20 parameters are allowed');

export type ScriptParameters = z.infer<typeof scriptParametersSchema>;
export type ScriptArguments = Record<string, string | number | boolean>;

export function validateScriptArguments(schema: ScriptParameters, input: unknown): ScriptArguments {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  const result: ScriptArguments = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown parameter: ${key}`);
  }
  for (const [key, rule] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined) {
      if (rule.required) throw new Error(`Missing parameter: ${key}`);
      continue;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.length > rule.maxLength || rule.enum && !rule.enum.includes(value)) {
        throw new Error(`Invalid string parameter: ${key}`);
      }
    } else if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) {
        throw new Error(`Invalid integer parameter: ${key}`);
      }
    } else if (typeof value !== 'boolean') throw new Error(`Invalid boolean parameter: ${key}`);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384) throw new Error('Parameters exceed 16 KiB');
  return result;
}

export function exampleScriptArguments(schema: ScriptParameters): ScriptArguments {
  return validateScriptArguments(schema, Object.fromEntries(Object.entries(schema).map(([name, rule]) => {
    if (rule.type === 'boolean') return [name, false];
    if (rule.type === 'integer') return [name, Math.max(rule.minimum, Math.min(rule.maximum, 0))];
    const value = rule.enum ? rule.enum.find(item => item.length <= rule.maxLength) : 'World'.slice(0, rule.maxLength);
    if (value === undefined) throw new Error(`No valid example for parameter: ${name}`);
    return [name, value];
  })));
}
