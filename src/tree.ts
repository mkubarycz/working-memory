import * as vscode from 'vscode';
import {
  listTopicsForWorkstream,
  listWorkstreams,
  Workstream,
  type WorkstreamTopicRow,
} from './db';

export class WorkstreamNode extends vscode.TreeItem {
  public readonly kind = 'workstream' as const;
  constructor(public readonly workstream: Workstream) {
    super(workstream.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `workstream:${workstream.id}`;
    this.description = workstream.slug;
    this.tooltip = `${workstream.title} (${workstream.slug}) — ${workstream.status}`;
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
  constructor(public readonly workstream: Workstream, count: number) {
    super(
      count > 0 ? `Topics (${count})` : 'Topics',
      count > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `topics-group:${workstream.id}`;
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
  ) {
    super(topic.title, vscode.TreeItemCollapsibleState.None);
    this.id = `topic:${workstream.id}:${topic.slug}`;
    const here = topic.entry_count_in_workstream;
    const elsewhere = topic.entry_count - here;
    const parts: string[] = [topic.slug];
    if (here > 0) {
      parts.push(`${here} entr${here === 1 ? 'y' : 'ies'} here`);
    }
    if (elsewhere > 0) {
      parts.push(`${elsewhere} elsewhere`);
    }
    if (topic.status !== 'active') {
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

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WMNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WMNode): WMNode[] {
    if (!element) {
      return listWorkstreams().map((w) => new WorkstreamNode(w));
    }
    if (element.kind === 'workstream') {
      const topics = listTopicsForWorkstream(element.workstream.id);
      return [new TopicsGroupNode(element.workstream, topics.length)];
    }
    if (element.kind === 'topics-group') {
      const topics = listTopicsForWorkstream(element.workstream.id);
      return topics.map((t) => new TopicNode(element.workstream, t));
    }
    return [];
  }
}
