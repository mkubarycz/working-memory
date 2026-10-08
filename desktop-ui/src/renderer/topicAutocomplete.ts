export const TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS = 10_000;
export const TOPIC_AUTOCOMPLETE_IDLE_MS = 900;

function sentenceCount(value: string): number {
  return value.match(/[.!?](?:\s|$)|\n+/g)?.length ?? 0;
}

export function shouldRequestTopicAutocomplete(input: {
  body: string;
  lastSuggestedBody: string;
  lastRequestedAt: number;
  now: number;
}): boolean {
  const body = input.body.trim();
  if (body.length < 24) return false;
  if (input.now - input.lastRequestedAt < TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS) return false;
  return sentenceCount(body) > sentenceCount(input.lastSuggestedBody);
}
