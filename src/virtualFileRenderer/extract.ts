import {
  DESCRIPTION_EMPTY_PLACEHOLDER,
  EDITABLE_COMMENT_END,
  EDITABLE_COMMENT_START,
  EDITABLE_DESCRIPTION_COMMENT_END,
  EDITABLE_DESCRIPTION_COMMENT_START,
  EDITABLE_LABEL_COMMENT_END,
  EDITABLE_LABEL_COMMENT_START,
} from './shared';

export function extractTopicBody(full: string): string {
  const lines = full.split(/\r?\n/);
  const fenceIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fenceIdxs.push(i);
      if (fenceIdxs.length === 2) {
        break;
      }
    }
  }
  if (fenceIdxs.length < 2) {
    throw new Error(
      'topic doc is missing the two `---` body fences — refusing to save',
    );
  }
  const body = lines
    .slice(fenceIdxs[0] + 1, fenceIdxs[1])
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
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
