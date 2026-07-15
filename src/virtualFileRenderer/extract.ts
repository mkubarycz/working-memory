import {
  DESCRIPTION_EMPTY_PLACEHOLDER,
  EDITABLE_ACTION_COMMENT_END,
  EDITABLE_ACTION_COMMENT_START,
  EDITABLE_COMMENT_END,
  EDITABLE_COMMENT_START,
  EDITABLE_DESCRIPTION_COMMENT_END,
  EDITABLE_DESCRIPTION_COMMENT_START,
  EDITABLE_INSTRUCTIONS_COMMENT_END,
  EDITABLE_INSTRUCTIONS_COMMENT_START,
  EDITABLE_LABEL_COMMENT_END,
  EDITABLE_LABEL_COMMENT_START,
  EDITABLE_STATUS_COMMENT_END,
  EDITABLE_STATUS_COMMENT_START,
} from './shared';

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
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the editable comment markers — refusing to save',
    );
  }
  const template = lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = '_No body template — add one here, then save (⌘S)._';
  if (template.trim() === placeholder) {
    return '';
  }
  return template;
}

export function extractTopicTypeLabel(full: string): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_LABEL_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_LABEL_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the label editable comment markers — refusing to save',
    );
  }
  return lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
}

export function extractTopicTypeDescription(full: string): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_DESCRIPTION_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_DESCRIPTION_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the description editable comment markers — refusing to save',
    );
  }
  const value = lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = DESCRIPTION_EMPTY_PLACEHOLDER;
  if (value.trim() === placeholder) {
    return '';
  }
  return value;
}

/** Pull the alert title; placeholder collapses to empty (H1 falls back to id). */
export function extractAlertTitle(full: string): string {
  const value = extractBetween(
    full,
    EDITABLE_LABEL_COMMENT_START,
    EDITABLE_LABEL_COMMENT_END,
    'alert',
  );
  return value.trim() === DESCRIPTION_EMPTY_PLACEHOLDER ? '' : value;
}

/** Pull the alert status token from its editable region. */
export function extractAlertStatus(full: string): string {
  return extractBetween(
    full,
    EDITABLE_STATUS_COMMENT_START,
    EDITABLE_STATUS_COMMENT_END,
    'alert',
  ).trim();
}

/** Pull the alert description; placeholder collapses to empty. */
export function extractAlertDescription(full: string): string {
  const value = extractBetween(
    full,
    EDITABLE_DESCRIPTION_COMMENT_START,
    EDITABLE_DESCRIPTION_COMMENT_END,
    'alert',
  );
  return value.trim() === DESCRIPTION_EMPTY_PLACEHOLDER ? '' : value;
}

/** Pull the alert recommended action; placeholder collapses to empty. */
export function extractAlertRecommendedAction(full: string): string {
  const value = extractBetween(
    full,
    EDITABLE_ACTION_COMMENT_START,
    EDITABLE_ACTION_COMMENT_END,
    'alert',
  );
  return value.trim() === DESCRIPTION_EMPTY_PLACEHOLDER ? '' : value;
}

/** Pull the nanite instructions from its editable region. */
export function extractNaniteInstructions(full: string): string {
  const value = extractBetween(
    full,
    EDITABLE_INSTRUCTIONS_COMMENT_START,
    EDITABLE_INSTRUCTIONS_COMMENT_END,
    'nanite',
  );
  const placeholder =
    '_No instructions yet — write the nanite playbook here, then save (⌘S)._';
  return value.trim() === placeholder ? '' : value;
}
