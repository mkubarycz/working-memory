import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scriptDefinitionSchema } from './hostScriptPolicy.js';

export function registerInstanceTaskTools(server: McpServer, dispatch: (method: string, path: string, input?: unknown) => unknown): void {
  const result = async (method: string, path: string, input?: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(dispatch(method, path, input)) }],
  });
  server.registerTool('wm-host-task-read', { description: 'List host task definitions. Requires Tools Read; the Host Tasks feature must be enabled.',
    inputSchema: {} }, () => result('GET', '/tasks'));
  server.registerTool('wm-host-task-create', { description: 'Register a host task definition. Requires Tools Create. Registration does not grant permission to execute it.',
    inputSchema: { definition: scriptDefinitionSchema } }, ({ definition }) => result('POST', '/tasks', definition));
  server.registerTool('wm-host-task-update', { description: 'Save a numbered draft task version. Requires Tools Update. The published version and its grants stay unchanged until the owner explicitly publishes a version in the desktop.',
    inputSchema: { id: z.string().uuid(), definition: scriptDefinitionSchema } }, ({ id, definition }) => result('POST', `/tasks/${id}`, definition));
  server.registerTool('wm-host-task-delete', { description: 'Revoke a task definition and cancel its jobs. Requires Tools Delete.',
    inputSchema: { id: z.string().uuid() } }, ({ id }) => result('POST', `/tasks/${id}/revoke`, {}));
  server.registerTool('wm-host-task-run', { description: 'Queue a host task. Requires Tools Run AND an unexpired owner-approved grant for this client and exact script version. Does not bypass host execution controls.',
    inputSchema: { taskId: z.string().uuid(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
      parameters: z.record(z.string(), z.unknown()), idempotencyKey: z.string().min(1).max(128) },
  }, input => result('POST', '/run', input));
  server.registerTool('wm-host-task-job-read', { description: 'Read a job belonging to this client. Requires Tools Read.',
    inputSchema: { id: z.string().uuid() } }, ({ id }) => result('GET', `/jobs/${id}`));
}
