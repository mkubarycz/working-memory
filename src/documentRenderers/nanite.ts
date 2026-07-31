/**
 * Per-kind renderer for a control-plane `Nanite` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * A Nanite is one execution instance of a Nanite Template. The two big blobs a
 * reader wants to inspect — the full REQUEST sent to the model (`spec.prompt`)
 * and its RESPONSE (`spec.output`) — are each rendered in their OWN COLLAPSED
 * `<details>` section so they don't flood the page; a compact Overview (phase,
 * links, timings, acceptance) sits above them. Unlike the generic fallback we
 * do NOT dump the raw spec/envelope, which would spill the same two blobs
 * inline.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { asStr, deepLink, fmtTs, metadataSection } from './shared';

interface Acceptance {
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

function readAcceptance(v: unknown): Acceptance | null {
  if (!v || typeof v !== 'object') {
    return null;
  }
  const o = v as Record<string, unknown>;
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    confidence: typeof o.confidence === 'number' ? o.confidence : 0,
    threshold: typeof o.threshold === 'number' ? o.threshold : 0,
    passed: o.passed === true,
  };
}

/** A collapsed `<details>` block, or '' when there's nothing to show. */
function collapsedSection(summary: string, body: string | null | undefined): string {
  const content = (body ?? '').trim();
  if (!content) {
    return '';
  }
  // Body is fenced so it renders VERBATIM (headings in the prompt don't turn
  // into page headings). A `~~~` fence avoids collision with ``` in model text.
  return [
    `<details>`,
    `<summary>${summary}</summary>`,
    '',
    '~~~text',
    content,
    '~~~',
    '',
    `</details>`,
  ].join('\n');
}

/** Optional hints the content provider resolves from the OWNING template. */
export interface NaniteRenderHints {
  /** Whether the owning template permits unattended (no-human) dispatch. */
  allowRunWithoutHuman?: boolean;
}

/** Plain-language status + next action for a phase, so a reader can tell what
 *  (if anything) they need to do. */
function statusLine(phase: string, hints: NaniteRenderHints): string {
  switch (phase) {
    case 'Pending':
      return hints.allowRunWithoutHuman
        ? '⏳ **Awaiting dispatch** — not queued yet. This template allows unattended runs, so an ' +
            'agent or parent nanite can enqueue it; or press **Run** to start it now.'
        : '⏳ **Awaiting your approval** — not queued yet. Press **Run** to queue it for the ' +
            'dispatcher. (Nothing will run it until you do.)';
    case 'Queued':
      return '🕒 **Queued** — waiting for a dispatcher slot; it will start automatically (oldest-first).';
    case 'Running':
      return '▶️ **Running now.**';
    case 'Succeeded':
      return '✅ **Succeeded** — see Acceptance below.';
    case 'Failed':
      return '❌ **Failed** — see `error` below.';
    default:
      return `**${phase}**`;
  }
}

export function renderNaniteDocument(
  env: DocumentEnvelope,
  hints: NaniteRenderHints = {},
): string {
  const spec = env.spec ?? {};
  const phase = asStr(spec.phase) ?? 'Pending';
  const templateId = asStr(spec.templateId);
  const workstream = asStr(spec.workstream);
  const inputTopic = asStr(spec.inputTopic);
  const request = asStr(spec.request);
  const error = asStr(spec.error);
  const acceptance = readAcceptance(spec.acceptance);
  const startedAt = typeof spec.startedAt === 'number' ? spec.startedAt : null;
  const endedAt = typeof spec.endedAt === 'number' ? spec.endedAt : null;
  const queuedAt = typeof spec.queuedAt === 'number' ? spec.queuedAt : null;
  const missingTools = Array.isArray(spec.missingTools)
    ? spec.missingTools.filter((x): x is string => typeof x === 'string')
    : [];

  const overview: string[] = [
    `- \`phase\`: ${phase}`,
    `- \`template\`: ${templateId ?? '_none_'}`,
    workstream
      ? `- \`workstream\`: [${workstream}](${deepLink('workstream', workstream)})`
      : `- \`workstream\`: _none_`,
    inputTopic
      ? `- \`inputTopic\`: [${inputTopic}](${deepLink('topic', inputTopic)})`
      : `- \`inputTopic\`: _none_`,
    `- \`request\`: ${request ?? '_none_'}`,
    `- \`queuedAt\`: ${fmtTs(queuedAt)}`,
    `- \`startedAt\`: ${fmtTs(startedAt)}`,
    `- \`endedAt\`: ${fmtTs(endedAt)}`,
  ];
  if (acceptance) {
    overview.push(
      `- \`acceptance\`: ${acceptance.passed ? 'passed' : 'failed'} (confidence ${acceptance.confidence} / threshold ${acceptance.threshold})`,
    );
  }
  if (missingTools.length > 0) {
    overview.push(`- \`missingTools\`: ${missingTools.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (error) {
    overview.push(`- \`error\`: ${error}`);
  }

  const lines: string[] = [
    `# Nanite: ${templateId ?? env.metadata.id}`,
    '',
    ...metadataSection(env),
    '',
    '## Status',
    '',
    statusLine(phase, hints),
    '',
    '## Overview',
    '',
    ...overview,
    '',
  ];

  const requestSection = collapsedSection(
    'Request — full prompt sent to the model',
    asStr(spec.prompt),
  );
  if (requestSection) {
    lines.push(requestSection, '');
  }
  if (acceptance?.summary) {
    lines.push('## Acceptance', '', acceptance.summary, '');
  }
  const responseSection = collapsedSection('Response — model output', asStr(spec.output));
  if (responseSection) {
    lines.push(responseSection, '');
  }

  return lines.join('\n');
}
