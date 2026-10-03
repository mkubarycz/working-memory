export interface ExpandableTreeNode {
  id: string;
  children?: readonly ExpandableTreeNode[];
}

export function setNodeAndChildrenExpanded(
  expanded: Set<string>,
  node: ExpandableTreeNode,
): void {
  expanded.add(node.id);
  for (const child of node.children ?? []) expanded.add(child.id);
}

export function setSubtreeExpanded(
  expanded: Set<string>,
  node: ExpandableTreeNode,
  isExpanded: boolean,
): void {
  if (isExpanded) {
    expanded.add(node.id);
  } else {
    expanded.delete(node.id);
  }

  for (const child of node.children ?? []) {
    setSubtreeExpanded(expanded, child, isExpanded);
  }
}