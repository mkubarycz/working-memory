import { appConfig } from './app/config.js';
import type { ResourceRegistry } from './framework/registry.js';

export function applicationContract(registry: ResourceRegistry) {
  return {
    contractVersion: appConfig.contractVersion,
    application: {
      id: appConfig.id,
      title: appConfig.title,
      description: appConfig.description,
      version: appConfig.version,
      capabilities: [
        'contract-discovery',
        'resource-query',
        'resource-get',
        'resource-create',
        'resource-update',
        'resource-delete',
        'audit-events',
        'domain-events',
      ],
      dataOwnership: 'application',
    },
    envelope: {
      kind: { type: 'string', description: 'Registered resource kind.' },
      metadata: {
        type: 'object',
        required: ['id', 'createdAt', 'updatedAt', 'resourceVersion'],
      },
      spec: { type: 'object', description: 'Kind-specific desired data.' },
      status: { type: 'object', description: 'Kind-specific current state.' },
      relationships: {
        type: 'object',
        description: 'Kind-specific typed references to other resources.',
      },
    },
    resources: registry.contract(),
  };
}
