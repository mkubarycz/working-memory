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
  return node.attributes?.find((item: Node) => item.type === 'Attribute' && item.name === name)?.value
    ?.map((part: Node) => part.data ?? '').join('');
}

it('opens host tasks inside the normal document tab without adding a main-grid row or modal', () => {
  const source = readFileSync(resolve(root, 'src/renderer/App.svelte'), 'utf8');
  const entries = nodes(parse(source, { modern: true }));
  const main = entries.find(({ node }) => node.type === 'RegularElement' && node.name === 'main'
    && attribute(node, 'class') === 'main')!.node;
  const directElements = main.fragment.nodes.filter((node: Node) => node.type === 'RegularElement');
  expect(attribute(directElements[0], 'class')).toBe('stage-content');
  expect(entries.filter(({ node }) => node.type === 'Component' && node.name === 'HostTasks')).toHaveLength(1);
  for (const entry of entries.filter(({ node }) => node.type === 'Component' && node.name === 'HostTasks')) {
    expect(entry.parents).toContain(main);
    expect(entry.parents.some((parent) => attribute(parent, 'role') === 'tabpanel')).toBe(true);
    expect(entry.parents.some((parent) => attribute(parent, 'class')?.includes('document-host'))).toBe(true);
  }
  const trigger = entries.find(({ node }) => node.type === 'RegularElement' && node.name === 'button'
    && source.slice(node.start, node.end).includes('onclick={openHostTasks}'))!;
  expect(attribute(trigger.node, 'aria-haspopup')).toBeUndefined();
  expect(trigger.parents.some((parent) => parent.name === 'footer'
    && attribute(parent, 'class') === 'desktop-status-bar')).toBe(true);
  expect(trigger.parents).not.toContain(main);

  const panel = readFileSync(resolve(root, 'src/renderer/HostTasks.svelte'), 'utf8');
  const panelNodes = nodes(parse(panel, { modern: true }));
  expect(panelNodes.some(({ node }) => node.name === 'dialog')).toBe(false);
  expect(panelNodes.filter(({ node }) => node.type === 'Component' && node.name === 'HostScripts')).toHaveLength(1);
  expect(panel).not.toMatch(/Thrive|Windows|workflow|showModal/);
  expect(source).toContain('openDocumentTab(documentTabsState(), hostTasksDocument(), false)');
  expect(source).toContain("reference.kind === 'host-tasks' && reference.identifier === hostTasksDocument().id");
  expect(source).toContain("activeDocument?.kind === 'host-tasks'");
  const styles = readFileSync(resolve(root, 'src/renderer/style.css'), 'utf8');
  expect(styles).toMatch(/\.main\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s);
});
