import * as vscode from 'vscode';
import {
  listTopicsForWorkstream,
  listWorkstreams,
  Workstream,
  WorkstreamWithCount,
  type WorkstreamTopicRow,
} from './db';

/**
 * Typed descriptor for a workstream tab. One entry per VS Code view; the
 * shared `WorkstreamTreeProvider` reads from `list()` for roots and from the
 * optional `describe()` hook for the secondary line under the title.
 */
export interface WorkstreamTabDef {
  /** Stable internal id, used as part of node ids to avoid collisions across views. */
  id: string;
  /** Must match the view id declared in `package.json` `contributes.views`. */
  viewId: string;
  /** Human label, mirrors the view title. */
  title: string;
  /** Source rows for this tab's roots. */
  list: () => WorkstreamWithCount[];
  /** Optional per-tab decoration for the workstream node's `description`. */
  describe?: (w: WorkstreamWithCount) => string | undefined;
}

export const TABS: WorkstreamTabDef[] = [
  {
    id: 'active',
    viewId: 'workingMemory.workstreams.active',
    title: 'Active',
    list: () =>
      listWorkstreams({ status: 'open', orderBy: 'last-activity-desc' }),
  },
  {
    id: 'archive',
    viewId: 'workingMemory.workstreams.archive',
    title: 'Archive',
    list: () =>
      listWorkstreams({ status: 'closed', orderBy: 'closed-desc' }),
    describe: (w) => w.closure?.trim() || undefined,
  },
];

export class WorkstreamNode extends vscode.TreeItem {
  public readonly kind = 'workstream' as const;
  constructor(
    public readonly workstream: Workstream,
    public readonly tabId: string,
    description?: string,
  ) {
    super(workstream.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${tabId}:workstream:${workstream.id}`;
    this.description = description ?? workstream.slug;
    const baseTooltip = `${workstream.title} (${workstream.slug}) — ${workstream.status}`;
    this.tooltip = workstream.closure?.trim()
      ? `${baseTooltip}\n\n${workstream.closure.trim()}`
      : baseTooltip;
    this.contextValue = 'workstream';
    this.iconPath = new vscode.ThemeIcon('repo');
    // Slug (not id) in the URI: stable across DB rebuilds, readable in the tab title.
    this.command = {
      command: 'vscode.open',
      title: 'Open Workstream',
      arguments: [
        vscode.Uri.parse(`working-memory:/workstream/${workstream.slug}.md`),
      ],
    };
  }
}

export class TopicsGroupNode extends vscode.TreeItem {
  public readonly kind = 'topics-group' as const;
  constructor(
    public readonly workstream: Workstream,
    public readonly tabId: string,
    count: number,
  ) {
    super(
      count > 0 ? `Topics (${count})` : 'Topics',
      count > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${tabId}:topics-group:${workstream.id}`;
    this.contextValue = 'topicsGroup';
    this.iconPath = new vscode.ThemeIcon('symbol-keyword');
    this.description = count > 0 ? undefined : 'none linked';
  }
}

export class TopicNode extends vscode.TreeItem {
  public readonly kind = 'topic' as const;
  constructor(
    public readonly workstream: Workstream,
    public readonly topic: WorkstreamTopicRow,
    public readonly tabId: string,
  ) {
    super(topic.title, vscode.TreeItemCollapsibleState.None);
    this.id = `${tabId}:topic:${workstream.id}:${topic.slug}`;
    const here = topic.entry_count_in_workstream;
    const elsewhere = topic.entry_count - here;
    const parts: string[] = [topic.slug];
    if (here > 0) {
      parts.push(`${here} entr${here === 1 ? 'y' : 'ies'} here`);
    }
    if (elsewhere > 0) {
      parts.push(`${elsewhere} elsewhere`);
    }
    if (topic.status !== 'open') {
      parts.push(topic.status);
    }
    this.description = parts.join(' • ');
    this.tooltip = `${topic.title} (${topic.slug}) — ${topic.status}`;
    this.contextValue = 'topic';
    this.iconPath = new vscode.ThemeIcon('symbol-key');
    this.command = {
      command: 'vscode.open',
      title: 'Open Topic',
      arguments: [
        vscode.Uri.parse(`working-memory:/topic/${topic.slug}.md`),
      ],
    };
  }
}

export type WMNode = WorkstreamNode | TopicsGroupNode | TopicNode;

export class WorkstreamTreeProvider
  implements vscode.TreeDataProvider<WMNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    WMNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(public readonly tab: WorkstreamTabDef) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WMNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WMNode): WMNode[] {
    if (!element) {
      return this.tab.list().map((w) => {
        const description = this.tab.describe
          ? this.tab.describe(w)
          : undefined;
        return new WorkstreamNode(w, this.tab.id, description);
      });
    }
    if (element.kind === 'workstream') {
      const topics = listTopicsForWorkstream(element.workstream.id);
      return [
        new TopicsGroupNode(element.workstream, this.tab.id, topics.length),
      ];
    }
    if (element.kind === 'topics-group') {
      const topics = listTopicsForWorkstream(element.workstream.id);
      return topics.map(
        (t) => new TopicNode(element.workstream, t, this.tab.id),
      );
    }
    return [];
  }
}
