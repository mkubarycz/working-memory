import * as vscode from 'vscode';

export interface ReshapeInput {
  template: string;
  body: string;
  title: string;
  typeLabel: string;
  typeDescription: string;
}

/**
 * Extract H2 section headers from a markdown string.
 * Returns lowercased header text for comparison.
 */
function extractH2Headers(markdown: string): string[] {
  const headers: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.+)$/.exec(line.trim());
    if (m?.[1]) {
      headers.push(m[1].trim().toLowerCase());
    }
  }
  return headers;
}

/**
 * Reshape the caller's topic body into the structure defined by `template`
 * using the VS Code Language Model API.
 *
 * Fidelity rule: the LLM MUST NOT invent facts, names, dates, numbers, or
 * decisions that aren't in the caller's input. If the LLM call fails or
 * drops more than half the template's H2 headers, throws so the caller can
 * apply the safe fallback.
 */
export async function reshapeTopicBody(input: ReshapeInput): Promise<string> {
  const { template, body, title, typeLabel, typeDescription } = input;

  const systemMessage = `You are reformatting user-provided content into a structured template. You MUST:
- Use only facts, names, dates, numbers, and decisions that appear in the user's input. Do not introduce new ones.
- Preserve the user's wording where possible. Light editing for fit is allowed; rewriting tone or "improving" prose is not.
- If a template section has no corresponding content in the input, write a single italicized placeholder like \`_Not provided._\` — do not invent content to fill it.
- If you are unsure whether a piece of input belongs in a section, include it under the closest match rather than dropping it.
- Do not add opinions, recommendations, or commentary unless the user's input already contains them.

The H2 section headers in the template are anchors. Preserve them exactly. The prose under each header in the template is a *prompt* describing what content belongs there — replace it with content drawn from the user's input.

Output ONLY the reshaped markdown body. Do not include a title heading, preamble, or explanation.`;

  const userMessage = `Topic title: ${title}
Topic type: ${typeLabel} — ${typeDescription}

Template (H2 headers are anchors; prose under each is a description of what to put there):
${template}

User's input to reshape into the template:
${body}`;

  const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  if (!model) {
    throw new Error('reshapeTopicBody: no language model available');
  }

  const request = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(systemMessage + '\n\n' + userMessage),
    ],
    {},
  );

  let result = '';
  for await (const fragment of request.stream) {
    if (fragment instanceof vscode.LanguageModelTextPart) {
      result += fragment.value;
    }
  }

  result = result.trim();

  // Validate: the reshaped output must preserve more than half the template's
  // H2 headers. If it drops too many, treat the result as a failure.
  const templateHeaders = extractH2Headers(template);
  if (templateHeaders.length > 0) {
    const resultHeaders = extractH2Headers(result);
    const preserved = templateHeaders.filter((h) =>
      resultHeaders.includes(h),
    ).length;
    if (preserved < Math.ceil(templateHeaders.length / 2)) {
      throw new Error(
        `reshapeTopicBody: output is missing too many template sections (${preserved}/${templateHeaders.length} preserved)`,
      );
    }
  }

  return result;
}
