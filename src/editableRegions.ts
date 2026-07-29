/**
 * Editable-region markers + extractors for the control-plane virtual docs.
 *
 * This module is the SAVE contract shared between the per-kind document
 * renderers (`documentRenderers/topic.ts`, `documentRenderers/topictype.ts`)
 * and the `WorkstreamDocumentProvider.writeFile` save path. On render, the
 * editable fields are wrapped in these HTML-comment markers (invisible in the
 * markdown preview); on save, the field values are sliced back out from between
 * the markers and persisted via the control-plane (`ws-topic-update` /
 * `ws-topictype-update`).
 *
 * VS Code-free AND journal-free by design, so it can be imported by the pure
 * renderers and unit-tested directly. (Extracted from the retired
 * `virtualFileRenderer/{shared,extract}.ts` during the WM journal rip-out.)
 */

export const EDITABLE_DIV_OPEN =
  '<div style="border-left: 5px solid green; padding-left: 15px;">';
export const EDITABLE_DIV_CLOSE = '</div>';
export const EDITABLE_COMMENT_START = '<!-- editable -->';
export const EDITABLE_COMMENT_END = '<!-- /editable -->';
export const EDITABLE_LABEL_COMMENT_START = '<!-- editable:label -->';
export const EDITABLE_LABEL_COMMENT_END = '<!-- /editable:label -->';
export const EDITABLE_DESCRIPTION_COMMENT_START = '<!-- editable:description -->';
export const EDITABLE_DESCRIPTION_COMMENT_END = '<!-- /editable:description -->';
export const DESCRIPTION_EMPTY_PLACEHOLDER = '—';

/** Slice the text between a comment-marker pair, trimming blank edges. */
function extractBetween(
  full: string,
  startMarker: string,
  endMarker: string,
  errLabel: string,
): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === startMarker) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === endMarker) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      `${errLabel} doc is missing the editable comment markers — refusing to save`,
    );
  }
  return lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
}

export function extractTopicBody(full: string): string {
  const body = extractBetween(
    full,
    EDITABLE_DESCRIPTION_COMMENT_START,
    EDITABLE_DESCRIPTION_COMMENT_END,
    'topic',
  );
  const placeholder = '_Empty body — write something here, then save (⌘S)._';
  if (body.trim() === placeholder) {
    return '';
  }
  return body;
}

export function extractTopicTypeBodyTemplate(full: string): string {
  const template = extractBetween(
    full,
    EDITABLE_COMMENT_START,
    EDITABLE_COMMENT_END,
    'topic-type',
  );
  const placeholder = '_No body template — add one here, then save (⌘S)._';
  if (template.trim() === placeholder) {
    return '';
  }
  return template;
}

export function extractTopicTypeLabel(full: string): string {
  return extractBetween(
    full,
    EDITABLE_LABEL_COMMENT_START,
    EDITABLE_LABEL_COMMENT_END,
    'topic-type',
  );
}

export function extractTopicTypeDescription(full: string): string {
  const value = extractBetween(
    full,
    EDITABLE_DESCRIPTION_COMMENT_START,
    EDITABLE_DESCRIPTION_COMMENT_END,
    'topic-type',
  );
  if (value.trim() === DESCRIPTION_EMPTY_PLACEHOLDER) {
    return '';
  }
  return value;
}
