export const TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS = 10_000;
export const TOPIC_AUTOCOMPLETE_IDLE_MS = 900;

export function topicAutocompleteDelay(input: {
  body: string;
  lastSuggestedBody: string;
  lastRequestedAt: number;
  now: number;
}): number | null {
  const body = input.body.trim();
  if (body.length < 24 || body === input.lastSuggestedBody.trim()) return null;
  return Math.max(
    TOPIC_AUTOCOMPLETE_IDLE_MS,
    TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS - (input.now - input.lastRequestedAt),
  );
}
