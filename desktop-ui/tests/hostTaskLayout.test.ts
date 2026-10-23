import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import { expect, it } from 'vitest';

type Node = Record<string, any>;
const root = resolve(import.meta.dirname, '..');

function nodes(value: unknown, parents: Node[] = []): Array<{ node: Node; parents: Node[] }> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, parents));
  const node = value as Node;
  return [
    ...(typeof node.type === 'string' ? [{ node, parents }] : []),
    ...Object.values(node).flatMap((child) => nodes(child, [...parents, node])),
  ];
}

function attribute(node: Node, name: string): string | undefined {
  const value = node.attributes?.find((item: Node) => item.type === 'Attribute' && item.name === name)?.value;
  return Array.isArray(value) ? value.map((part: Node) => part.data ?? '').join('') : undefined;
}

it('places the task list beside Container Apps and task details in the document stage, not the footer', () => {
  const source = readFileSync(resolve(root, 'src/renderer/App.svelte'), 'utf8');
  const entries = nodes(parse(source, { modern: true }));
  const main = entries.find(({ node }) => node.type === 'RegularElement' && node.name === 'main'
    && attribute(node, 'class') === 'main')!.node;
  const directElements = main.fragment.nodes.filter((node: Node) => node.type === 'RegularElement');
  expect(attribute(directElements[0], 'class')).toBe('stage-content');
  expect(entries.filter(({ node }) => node.type === 'Component' && node.name === 'HostTasks')).toHaveLength(1);
  for (const entry of entries.filter(({ node }) => node.type === 'Component' && node.name === 'HostTasks')) {
    expect(entry.parents).not.toContain(main);
    expect(entry.parents.some((parent) => attribute(parent, 'role') === 'tabpanel')).toBe(true);
    expect(entry.parents.some((parent) => attribute(parent, 'id') === 'desktop-panel-host-tasks')).toBe(true);
    expect(entry.parents.some(parent => parent.name === 'aside' && attribute(parent, 'class') === 'chat-rail')).toBe(true);
  }
  const detail = entries.find(({ node }) => node.type === 'Component' && node.name === 'HostScripts')!;
  expect(detail.parents).toContain(main);
  expect(detail.parents.some(parent => attribute(parent, 'class')?.includes('document-host'))).toBe(true);
  const trigger = entries.find(({ node }) => node.type === 'RegularElement' && node.name === 'button'
    && attribute(node, 'id') === 'desktop-tab-host-tasks')!;
  expect(attribute(trigger.node, 'aria-haspopup')).toBeUndefined();
  expect(trigger.parents.some(parent => attribute(parent, 'role') === 'tablist')).toBe(true);
  expect(trigger.parents.some(parent => parent.name === 'footer')).toBe(false);
  expect(source.indexOf('>Container Apps</button>')).toBeLessThan(source.indexOf('>Host Tasks</button>'));
  expect(trigger.parents).not.toContain(main);

  const panel = readFileSync(resolve(root, 'src/renderer/HostTasks.svelte'), 'utf8');
  const panelNodes = nodes(parse(panel, { modern: true }));
  expect(panelNodes.some(({ node }) => node.name === 'dialog')).toBe(false);
  expect(panelNodes.filter(({ node }) => node.type === 'Component' && node.name === 'HostScripts')).toHaveLength(1);
  expect(panel).not.toMatch(/Thrive|Windows|workflow|showModal/);
  expect(source).toContain('task ? hostTaskDocument(task) : newHostTaskDocument(), false');
  expect(source).toContain("reference.kind === 'host-task' && instanceFeatures.hostTasks");
  expect(source).toContain('onSelect={openHostTask}');
  expect(source).toContain('onRegistered={hostTaskRegistered}');
  expect(source).toContain('onTaskRead={updateHostTaskTitle}');
  expect(source).toContain('hidden={activeHeaderTab !== \'host-tasks\'} inert={activeHeaderTab !== \'host-tasks\'}');
  const styles = readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8');
  expect(styles).toMatch(/\.main\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s);
});
