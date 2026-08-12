/**
 * `ws-nanitejournal-create` — the NaniteJournal kind's Create tool.
 *
 * Appends ONE immutable record of a nanite run. The extension-host runner calls
 * this on every completion (success or failure) INSTEAD of stamping the result
 * onto the nanite spec. Provide the owning `naniteId` + scope (`workstream`,
 * `inputTopic`) and the four spec sections (`status`, `prompt`, `execution`,
 * `results`); the spec is validated against the NaniteJournal kind. Returns the
 * created journal (its `id` is the pointer the nanite stores as
 * `latestJournalId`).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { NaniteJournal, NANITE_JOURNAL_KIND } from './naniteJournal.js';

/** Register the `ws-nanitejournal-create` tool. */
export function registerWsNaniteJournalCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitejournal-create',
    {
      title: 'Nanite Journal: Create',
      description:
        'Append ONE immutable record of a nanite run. Provide the owning `naniteId` (required) ' +
        'plus scope (`workstream`, `inputTopic`) and the four spec sections: `status` ' +
        '(phase/outcome + timing), `prompt` (the full request sent to the model), `execution` ' +
        '(the ordered `steps` trace + any `error`), and `results` (`summary`, the acceptance ' +
        'verdict, and execution stats: `tokens`, `missingTools`). The spec is ' +
        'validated against the NaniteJournal kind. Returns the created journal.',
      inputSchema: {
        naniteId: z.string().describe('Document id of the nanite this run belongs to (required).'),
        workstream: z.string().optional().describe('Owning workstream slug (scope).'),
        inputTopic: z.string().optional().describe('Input topic slug (empty for a workstream-wide run).'),
        status: z
          .object({
            phase: z.enum(['Pending', 'Queued', 'Running', 'Succeeded', 'Failed']).optional(),
            outcome: z.enum(['succeeded', 'failed']).nullable().optional(),
            queuedAt: z.number().nullable().optional(),
            startedAt: z.number().nullable().optional(),
            endedAt: z.number().nullable().optional(),
          })
          .optional()
          .describe('Section 1 — phase/outcome + timing (queuedAt, startedAt, endedAt).'),
        prompt: z
          .object({
            request: z.string().optional(),
          })
          .optional()
          .describe('Section 2 — all run input (the full request/instructions+context sent to the model).'),
        execution: z
          .object({
            steps: z
              .array(
                z.object({
                  kind: z.enum(['assistant', 'tool']),
                  round: z.number().optional(),
                  text: z.string().optional(),
                  name: z.string().optional(),
                  ok: z.boolean().optional(),
                  input: z.string().optional(),
                  result: z.string().optional(),
                  error: z.string().optional(),
                  resultDigest: z
                    .object({
                      count: z.number(),
                      items: z
                        .array(
                          z.object({
                            id: z.string().optional(),
                            slug: z.string().optional(),
                            title: z.string().optional(),
                            name: z.string().optional(),
                            resourceVersion: z.number().optional(),
                          }),
                        )
                        .optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
            error: z.string().optional(),
          })
          .optional()
          .describe('Section 3 — the ordered execution `steps` trace + any `error` encountered.'),
        results: z
          .object({
            summary: z.string().optional(),
            acceptance: z
              .object({
                summary: z.string(),
                confidence: z.number(),
                threshold: z.number(),
                passed: z.boolean(),
              })
              .nullable()
              .optional(),
            tokens: z
              .object({
                input_tokens: z.number(),
                output_tokens: z.number(),
                total_tokens: z.number(),
              })
              .nullable()
              .optional(),
            missingTools: z.array(z.string()).optional(),
          })
          .optional()
          .describe('Section 4 — summary, acceptance verdict, and execution stats (tokens, missingTools).'),
      },
    },
    async ({ naniteId, workstream, inputTopic, status, prompt, execution, results }) => {
      const specInput: Record<string, unknown> = { naniteId };
      if (workstream !== undefined) {
        specInput.workstream = workstream;
      }
      if (inputTopic !== undefined) {
        specInput.inputTopic = inputTopic;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      if (prompt !== undefined) {
        specInput.prompt = prompt;
      }
      if (execution !== undefined) {
        specInput.execution = execution;
      }
      if (results !== undefined) {
        specInput.results = results;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(NANITE_JOURNAL_KIND, specInput);
        docStatus = defaultStatus(NANITE_JOURNAL_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: NANITE_JOURNAL_KIND,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new NaniteJournal(doc));
    },
  );
}
