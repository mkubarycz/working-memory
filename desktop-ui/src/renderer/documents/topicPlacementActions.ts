import type { TopicPlacement, TopicPlacementApply, TopicPlacementSuggestion } from '../../../../control-plane/src/topicPlacementContract';
import type { SearchBugReportInput } from '../../shared/contracts';

export function placementApplyInput(id: string, result: TopicPlacement, suggestion: TopicPlacementSuggestion): TopicPlacementApply {
  return {
    id, expectedResourceVersion: result.sourceVersion,
    parent: suggestion.parent ? { id: suggestion.parent.id, resourceVersion: suggestion.parent.resourceVersion } : null,
    workstream: { id: suggestion.workstream.id, resourceVersion: suggestion.workstream.resourceVersion },
  };
}

export function placementBugContext(
  source: { id: string; title: string; resourceVersion: number },
  result: TopicPlacement | null, selected: TopicPlacementSuggestion | null, error: string, loading: boolean,
): SearchBugReportInput['search'] {
  return {
    prompt: 'Suggest Placement',
    context: { document: { id: source.id, title: source.title, kind: 'Topic' } },
    response: null,
    ...(selected ? { supportingEvidence: [
      `Suggested parent: ${selected.parent?.title ?? 'No new parent recommended'}`,
      `Suggested workstream: ${selected.workstream.title}`,
      `Similarity: ${selected.similarity.toFixed(2)}`,
      `Confidence: ${selected.confidence.level} - ${selected.confidence.reason}`,
      selected.evidence === 'parent-membership' ? 'Evidence: parent belongs to this workstream.' : 'Evidence: similar workstream content.',
      ...(result?.limited ? ['Only the first 32,000 body characters were indexed.'] : []),
      `Supporting excerpt:\n${selected.excerpt}`,
    ].join('\n') } : {}),
    trace: [{
      id: 'topic-placement', tool: 'wm-topic-suggest-placement', durationMs: 0,
      status: error ? 'error' : 'success', ...(error ? { error } : {}),
      arguments: { source, result, selectedSuggestion: selected, capturedAt: new Date().toISOString(),
        note: 'Advisory placement only. Duration was not measured.' },
    }],
    loading, error, notice: 'Topic auto-triage placement; selection is not an authored relationship.', requestId: null,
  };
}
