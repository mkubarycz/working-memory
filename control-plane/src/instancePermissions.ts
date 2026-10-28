import { z } from 'zod';

const crud = z.object({ create: z.boolean(), read: z.boolean(), update: z.boolean(), delete: z.boolean() }).strict();
export const instancePermissionsSchema = z.object({
  content: crud, settings: crud, tools: crud.extend({ run: z.boolean() }).strict(),
}).strict();
export type InstancePermissions = z.infer<typeof instancePermissionsSchema>;
export type PermissionCategory = keyof InstancePermissions;
export type PermissionOperation = keyof InstancePermissions['tools'];
export const permissionSelectionSchema = z.object({
  category: z.enum(['content', 'settings', 'tools']),
  operation: z.enum(['create', 'read', 'update', 'delete', 'run']),
}).strict().refine(value => value.operation !== 'run' || value.category === 'tools', 'Run applies only to Tools.');
export const permissionRequestSchema = z.array(permissionSelectionSchema).min(1).max(13);
export type PermissionSelection = z.infer<typeof permissionSelectionSchema>;

export function emptyInstancePermissions(): InstancePermissions {
  const value = { create: false, read: false, update: false, delete: false };
  return { content: { ...value }, settings: { ...value }, tools: { ...value, run: false } };
}

export function selectedPermissions(permissions: InstancePermissions): PermissionSelection[] {
  return (['content', 'settings', 'tools'] as const).flatMap(category =>
    (['create', 'read', 'update', 'delete', 'run'] as const)
      .filter(operation => permits(permissions, category, operation))
      .map(operation => ({ category, operation })));
}

export function defaultInstancePermissions(access: 'read' | 'write'): InstancePermissions {
  const value = { create: access === 'write', read: true, update: access === 'write', delete: access === 'write' };
  return { content: { ...value }, settings: { ...value }, tools: { create: false, read: false, update: false, delete: false, run: false } };
}

export function permits(permissions: InstancePermissions, category: PermissionCategory, operation: PermissionOperation): boolean {
  return operation === 'run' ? category === 'tools' && permissions.tools.run : permissions[category][operation];
}

export function documentPermissionCategory(kind: string): 'content' | 'settings' | null {
  if (['Config', 'TopicType', 'Agent', 'ContainerClaim'].includes(kind)) return 'settings';
  if (['Topic', 'Workstream', 'Alert', 'AgentMessage', 'CommandJournal'].includes(kind)) return 'content';
  return null;
}
