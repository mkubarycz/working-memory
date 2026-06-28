import { JournalStore } from '../db';
import {
  DESCRIPTION_EMPTY_PLACEHOLDER,
  EDITABLE_COMMENT_END,
  EDITABLE_COMMENT_START,
  EDITABLE_DESCRIPTION_COMMENT_END,
  EDITABLE_DESCRIPTION_COMMENT_START,
  EDITABLE_DIV_CLOSE,
  EDITABLE_DIV_OPEN,
  EDITABLE_LABEL_COMMENT_END,
  EDITABLE_LABEL_COMMENT_START,
  deepLink,
  fmtDateTime,
} from './shared';

export function renderTopicTypeDoc(store: JournalStore, id: string): string {
  const topicType = store.getTopicType(id);
  if (!topicType) {
    return `# Topic type not found\n\nNo topic type with id \`${id}\`.`;
  }
  const recentTopics = store
    .listTopics({ status: 'open', topicType: id })
    .slice()
    .sort((a, b) => b.updated_at - a.updated_at || a.slug.localeCompare(b.slug))
    .slice(0, 25);
  const recentBlock = recentTopics.length
    ? recentTopics
        .map(
          (topic) =>
            `- [${topic.title}](${deepLink('topic', topic.slug)}) \`${topic.slug}\` — updated ${fmtDateTime(topic.updated_at)}`,
        )
        .join('\n')
    : '_No open topics of this type._';

  const bodyTemplatePlaceholder =
    '_No body template — add one here, then save (⌘S)._';
  const bodyTemplateContent = topicType.body_template.trim()
    ? topicType.body_template
    : bodyTemplatePlaceholder;

  return [
    `# ${topicType.label} \`${topicType.id}\``,
    '',
    `- **Icon:** \`${topicType.icon}\``,
    `- **Id:** \`${topicType.id}\``,
    `- **Created:** ${fmtDateTime(topicType.created_at)}`,
    `- **Updated:** ${fmtDateTime(topicType.updated_at)}`,
    `- **Topics using this type:** ${topicType.topic_count}`,
    '',
    '## Label',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_LABEL_COMMENT_START,
    '',
    topicType.label,
    '',
    EDITABLE_LABEL_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Description',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_DESCRIPTION_COMMENT_START,
    '',
    topicType.description.trim() || DESCRIPTION_EMPTY_PLACEHOLDER,
    '',
    EDITABLE_DESCRIPTION_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Content Template',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_COMMENT_START,
    '',
    bodyTemplateContent,
    '',
    EDITABLE_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Recent topics',
    '',
    recentBlock,
    '',
  ].join('\n');
}
