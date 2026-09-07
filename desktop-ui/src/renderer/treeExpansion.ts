export interface ExpandableTreeNode {
  id: string;
  children?: readonly ExpandableTreeNode[];
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