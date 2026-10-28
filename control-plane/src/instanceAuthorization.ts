import type { Store } from './store.js';
import type { InstancePrincipal } from './instanceAccess.js';
import { documentPermissionCategory, permits, type PermissionCategory, type PermissionOperation, type PermissionSelection } from './instancePermissions.js';

export function authorizeInstanceTool(principal: InstancePrincipal, name: string, args: Record<string, unknown>, store: Store): boolean {
  if (principal.role === 'owner') return true;
  if (name === 'wm-ping' || name === 'wm-list-kinds') return true;
  if (name === 'wm-document-read') {
    const kind = typeof args.id === 'string' ? store.getDocument({ id: args.id, includeDeleted: true })?.kind ?? args.kind : args.kind;
    if (typeof kind !== 'string') return principal.permissions.content.read || principal.permissions.settings.read;
  }
  const required = instanceToolPermissions(name, args, store);
  return required !== null && required.every(({ category, operation }) => permits(principal.permissions, category, operation));
}

export function instanceToolPermissions(name: string, args: Record<string, unknown>, store: Store): PermissionSelection[] | null {
  const required = (category: PermissionCategory, operation: PermissionOperation): PermissionSelection[] => [{ category, operation }];
  if (name === 'wm-attachment-create') return required('content', 'create');
  const generic = /^wm-document-(create|read|update|delete)$/.exec(name);
  if (generic) {
    let kind = typeof args.kind === 'string' ? args.kind : undefined;
    if (generic[1] !== 'create' && typeof args.id === 'string') {
      kind = store.getDocument({ id: args.id, includeDeleted: true })?.kind ?? kind;
    }
    const operation = generic[1] === 'delete' && args.restore === true ? 'update' : generic[1] as 'create' | 'read' | 'update' | 'delete';
    if (!kind && operation === 'read') return required('content', 'read');
    if (!kind) return [...required('content', operation), ...required('settings', operation)];
    const category = documentPermissionCategory(kind);
    return category !== null ? required(category, operation) : null;
  }
  const host = /^wm-host-task-(create|read|update|delete|run|job-read)$/.exec(name);
  if (host) return required('tools', host[1] === 'job-read' ? 'read' : host[1] as PermissionOperation);
  const namespaced = /^ws-(workstream|topic|topictype|alert|agent-message|agent|containerclaim|commandjournal|config)-(.+)$/.exec(name);
  if (!namespaced) return null;
  const category = ['config', 'topictype', 'agent', 'containerclaim'].includes(namespaced[1]) ? 'settings' : 'content';
  const verb = namespaced[2];
  if (verb === 'restore' || verb === 'delete' && args.restore === true) return required(category, 'update');
  if (['create', 'read', 'update', 'delete'].includes(verb)) return required(category, verb as PermissionOperation);
  if (['list', 'get', 'pending'].includes(verb)) return required(category, 'read');
  if (['acknowledge', 'resolve', 'reopen', 'dismiss', 'reorder', 'close-tree', 'append', 'finalize', 'focus', 'clear-focus'].includes(verb)) {
    return required(category, 'update');
  }
  if (verb === 'transfer') return [...required(category, 'create'), ...required(category, 'update')];
  return null;
}
