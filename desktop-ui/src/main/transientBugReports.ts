import type { ChatBugReportDraft, FeedbackContext, SharedTopicReceipt } from '../shared/contracts';

export class TransientBugReports {
  protected latest: { draft: ChatBugReportDraft; sourceUrl: string; context: FeedbackContext } | undefined;

  protected keep(draft: ChatBugReportDraft, sourceUrl: string, context: FeedbackContext): ChatBugReportDraft {
    this.latest = { draft, sourceUrl, context };
    return { ...draft };
  }

  feedbackSource(id: string) {
    const report = this.latest;
    if (!report || report.draft.id !== id) return undefined;
    return {
      topic: { title: report.draft.title, body: report.draft.body }, sourceUrl: report.sourceUrl, context: report.context,
      recordReceipt: async (receipt: SharedTopicReceipt) => {
        if (!report.draft.body.includes(receipt.statusUrl)) {
          report.draft.body += `\n\nFeedback sent on ${receipt.submittedAt}. [Check status](${receipt.statusUrl})`;
        }
      },
    };
  }
}
