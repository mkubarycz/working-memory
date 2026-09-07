function projectIpcValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (
    value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
    || typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Unsupported IPC payload value: ${typeof value}`);
  }

  const object = value as object;
  const existing = seen.get(object);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    seen.set(object, projected);
    for (const item of value) projected.push(projectIpcValue(item, seen));
    return projected;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const projected: Record<string, unknown> = {};
    seen.set(object, projected);
    for (const key of Object.keys(value)) {
      Object.defineProperty(projected, key, {
        value: projectIpcValue((value as Record<string, unknown>)[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return projected;
  }

  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`Unsupported IPC payload object: ${prototype?.constructor?.name ?? 'unknown'}`);
  }
}

export function toIpcPayload<T>(value: T): T {
  return projectIpcValue(value, new WeakMap()) as T;
}