import { z } from 'zod';
import { exampleScriptArguments, scriptDefinitionSchema, scriptParametersSchema, validateScriptArguments,
  type ScriptDefinition, type ScriptDetails, type ScriptJob, type ScriptVersion } from '../../../control-plane/src/hostScriptPolicy';
import type { StartChatInput } from './desktopChatAgent';

export interface HostScriptChatService {
  read(): Promise<ScriptDetails>;
  save(definition: ScriptDefinition, expectedLatestVersion: number): Promise<ScriptVersion>;
  test(version: number, parameters: unknown, signal?: AbortSignal): Promise<ScriptJob>;
}

const readSchema = z.object({ version: z.number().int().positive().optional() }).strict();
const updateSchema = z.object({
  baseVersion: z.number().int().positive(), expectedLatestVersion: z.number().int().positive(),
  source: z.string().min(1).max(32768).optional(), parameters: scriptParametersSchema.optional(),
  name: scriptDefinitionSchema.shape.name.optional(), description: scriptDefinitionSchema.shape.description.optional(),
  timeoutMs: scriptDefinitionSchema.shape.timeoutMs.optional(),
}).strict().refine(input => [input.source, input.parameters, input.name, input.description, input.timeoutMs]
  .some(value => value !== undefined), 'Supply settings, source or parameters to edit');
const testSchema = z.object({
  version: z.number().int().positive(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.record(z.string(), z.unknown()),
}).strict();

export function createHostScriptChatTools(
  service: HostScriptChatService, taskId: string, initialVersion?: number,
): NonNullable<StartChatInput['appTools']> {
  z.string().uuid().parse(taskId);
  if (initialVersion !== undefined) z.number().int().positive().parse(initialVersion);
  let selectedVersion = initialVersion;
  const controller = new AbortController();
  const describe = (details: ScriptDetails, version: ScriptVersion) => ({
    taskId, title: version.definition.name, name: version.definition.name, description: version.definition.description,
    version: version.version, publishedVersion: details.task.publishedVersion,
    latestVersion: details.task.latestVersion, definitionHash: version.definitionHash,
    source: version.definition.source, parameters: version.definition.parameters,
    timeoutMs: version.definition.timeoutMs, exampleInput: exampleScriptArguments(version.definition.parameters),
  });
  return {
    tools: [
      { name: 'desktop-host-task-read', description: 'Read the targeted host task code, parameter contract and version. Start here before edits or tests.',
        inputSchema: z.toJSONSchema(readSchema) },
      { name: 'desktop-host-task-update', description: 'Save name, description, time limit, code or parameter changes as a numbered draft of this task. Read first; use its version as baseVersion and latestVersion as expectedLatestVersion. Never publishes.',
        inputSchema: z.toJSONSchema(updateSchema) },
      { name: 'desktop-host-task-test-run', description: 'Execute one exact task version on the host as the user, NOT sandboxed. Requires chat approval for each call. Use version/hash returned by read or update. Returns the real result/error without starting a general runner.',
        inputSchema: z.toJSONSchema(testSchema) },
    ],
    systemInstructions: [
      `The chat target is host task ${JSON.stringify(taskId)}${initialVersion ? `, displayed version ${initialVersion}` : ''}.`,
      'Use desktop-host-task-read/update/test-run for this task, not document/Topic/Config tools.',
      'Read its actual code and parameters before editing. Save edits as drafts, then use the returned exact version and hash for a test.',
      'Ask for a test via the tool when needed; the user must approve each host execution in chat. Never bypass confirmation using other tools.',
      'A failed test is a real failure: explain it or fix the draft and request a new test. Do not claim a test passed without a succeeded result.',
      'Publishing and caller grants remain explicit manual desktop actions; there is no publishing tool.',
      'Host tasks are not Topic documents. Refer to this task by name, without inventing a document deep link.',
    ].join(' '),
    requiresConfirmation: name => name === 'desktop-host-task-test-run',
    separateConfirmation: name => name === 'desktop-host-task-test-run',
    deduplicate: () => false,
    onCancel: () => controller.abort(),
    async callTool(name, args) {
      try {
        controller.signal.throwIfAborted();
        const details = await service.read();
        controller.signal.throwIfAborted();
        if (details.task.id !== taskId) throw new Error('The host task target changed.');
        if (name === 'desktop-host-task-read') {
          const input = readSchema.parse(args);
          const version = details.versions.find(item => item.version === (input.version ?? selectedVersion ?? details.task.latestVersion));
          if (!version) throw new Error('Task version not found');
          return { ok: true, result: describe(details, version) };
        }
        if (name === 'desktop-host-task-update') {
          const input = updateSchema.parse(args);
          const base = details.versions.find(item => item.version === input.baseVersion);
          if (!base) throw new Error('Read the task version before editing');
          const version = await service.save({
            ...base.definition,
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          }, input.expectedLatestVersion);
          selectedVersion = version.version;
          return { ok: true, result: describe({ ...details, task: { ...details.task, latestVersion: version.version } }, version) };
        }
        if (name === 'desktop-host-task-test-run') {
          const input = testSchema.parse(args);
          const version = details.versions.find(item => item.version === input.version);
          if (!version || version.definitionHash !== input.definitionHash) throw new Error('The approved test version/hash does not match');
          const parameters = validateScriptArguments(version.definition.parameters, input.parameters);
          const job = await service.test(input.version, parameters, controller.signal);
          return { ok: true, result: { taskId, title: version.definition.name, version: job.version, jobId: job.id, state: job.state,
            result: job.resultJson === null ? null : JSON.parse(job.resultJson), error: job.error } };
        }
        return { ok: false, error: `Unknown host task tool: ${name}` };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}
