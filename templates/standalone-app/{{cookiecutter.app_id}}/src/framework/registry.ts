import { z } from 'zod';
import type { ResourceDefinition } from './types.js';

export class ResourceRegistry {
  readonly #definitions = new Map<string, ResourceDefinition>();

  register(definition: ResourceDefinition): this {
    if (this.#definitions.has(definition.kind)) {
      throw new Error(`Resource kind "${definition.kind}" is already registered.`);
    }
    this.#definitions.set(definition.kind, definition);
    return this;
  }

  get(kind: string): ResourceDefinition {
    const definition = this.#definitions.get(kind);
    if (!definition) {
      throw new Error(`Unknown resource kind "${kind}". Discover the live contract before querying resources.`);
    }
    return definition;
  }

  list(): ResourceDefinition[] {
    return [...this.#definitions.values()];
  }

  contract() {
    return this.list().map((definition) => ({
      kind: definition.kind,
      description: definition.description,
      schema: {
        spec: z.toJSONSchema(definition.spec),
        status: z.toJSONSchema(definition.status),
        relationships: z.toJSONSchema(definition.relationships),
      },
      relationships: definition.relationshipDescriptors,
      businessRules: definition.businessRules,
    }));
  }
}
