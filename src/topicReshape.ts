import * as vscode from 'vscode';

/**
 * The fidelity rule that MUST be included verbatim in every reshape prompt.
 * It strictly prohibits the LLM from inventing content beyond what the caller supplied.
 */
const FIDELITY_RULE = `You are reformatting user-provided content into a structured template. You MUST:
- Use only facts, names, dates, numbers, and decisions that appear in the user's input. Do not introduce new ones.
- Preserve the user's wording where possible. Light editing for fit is allowed; rewriting tone or "improving" prose is not.
- If a template section has no corresponding content in the input, write a single italicized placeholder like \`_Not provided._\` — do not invent content to fill it.
- If you are unsure whether a piece of input belongs in a section, include it under the closest match rather than dropping it.
- Do not add opinions, recommendations, or commentary unless the user's input already contains them.

The H2 section headers in the template are anchors. Preserve them exactly. The prose under each header in the template is a *prompt* describing what content belongs there — replace it with content drawn from the user's input.`;

export interface ReshapeInput {
  template: string;
  body: string;
  title: string;
  typeLabel: string;
  typeDescription: string;
}

/**
 * Reshape caller-supplied body content into the per-type body template structure
 * using VS Code's Language Model API (Copilot).
 *
 * This is reshape-only — it is strictly forbidden from inventing facts.
 * See FIDELITY_RULE above.
 *
 * Throws when no model is available or the model request fails.
 */
export async function reshapeTopicBody(input: ReshapeInput): Promise<string> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const model = models[0];
  if (!model) {
    throw new Error('No Copilot language model available for body reshaping');
  }

  const systemPrompt = [
    FIDELITY_RULE,
    '',
    `Topic type: ${input.typeLabel}`,
    `Type description: ${input.typeDescription}`,
    '',
    'Template (H2 headers are section anchors; prose under each header describes expected content):',
    '```markdown',
    input.template,
    '```',
  ].join('\n');

  const userPrompt = [
    `Topic title: ${input.title}`,
    '',
    'User-provided body to reshape into the template:',
    '```markdown',
    input.body,
    '```',
    '',
    'Reformat the above body content into the template structure. Output ONLY the reshaped markdown body — no code fences, no preamble, no explanation.',
  ].join('\n');

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  const token = new vscode.CancellationTokenSource().token;
  const response = await model.sendRequest(messages, {}, token);

  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  return text.trim();
}

/**
 * Extract all H2 header texts from a markdown string.
 * Used to validate that the reshaped body preserves the template's section structure.
 */
export function extractH2Headers(markdown: string): string[] {
  const headers: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.+)/.exec(line);
    if (m?.[1]) {
      headers.push(m[1].trim().toLowerCase());
    }
  }
  return headers;
}
