import type { TopicAutocompleteInput, TopicAutocompleteResult } from '../shared/contracts';

export function topicAutocompletePrompt(input: TopicAutocompleteInput): string {
  const allowedTypes = input.topicTypes
    .filter((type) => type.id.trim())
    .map((type) => `${type.id}: ${type.label}${type.description ? ` - ${type.description}` : ''}`)
    .join('\n');
  const workstream = input.currentWorkstreamTitle !== undefined;
  return 'Suggest a concise title and the best topic type for this draft. ' +
    (workstream
      ? 'Also suggest a concise workstream name for the broader initiative containing this first topic. ' +
        'Return only JSON with string fields "title", "topicType", and "workstreamTitle". ' +
        'Both titles must be at most 120 characters. '
      : 'Return only JSON with string fields "title" and "topicType". ' +
        'The title must be at most 120 characters. ') +
    `Allowed topic types:\n${allowedTypes}\n\n` +
    `Current title: ${input.currentTitle}\nCurrent type: ${input.currentTopicType}\n` +
    (workstream ? `Current workstream title: ${input.currentWorkstreamTitle}\n` : '') +
    `\nDraft:\n${input.body.slice(0, 12_000)}`;
}

export function parseTopicAutocomplete(text: string, input: TopicAutocompleteInput): TopicAutocompleteResult {
  let suggestion: unknown;
  try {
    suggestion = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    throw new Error('Autocomplete model returned invalid JSON.');
  }
  if (!suggestion || typeof suggestion !== 'object') {
    throw new Error('Autocomplete model returned an invalid suggestion.');
  }
  const title = 'title' in suggestion && typeof suggestion.title === 'string'
    ? suggestion.title.trim().slice(0, 120)
    : '';
  const requestedType = 'topicType' in suggestion && typeof suggestion.topicType === 'string'
    ? suggestion.topicType.trim()
    : '';
  const topicType = input.topicTypes.some((type) => type.id === requestedType)
    ? requestedType
    : input.currentTopicType;
  if (!title) throw new Error('Autocomplete model did not suggest a title.');
  if (input.currentWorkstreamTitle === undefined) return { title, topicType };
  const workstreamTitle = 'workstreamTitle' in suggestion && typeof suggestion.workstreamTitle === 'string'
    ? suggestion.workstreamTitle.trim().slice(0, 120)
    : '';
  if (!workstreamTitle) throw new Error('Autocomplete model did not suggest a workstream title.');
  return { title, topicType, workstreamTitle };
}
