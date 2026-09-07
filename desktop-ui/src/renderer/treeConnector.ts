export interface ConnectorPoint {
  x: number;
  y: number;
}

function outdentCurve(from: ConnectorPoint, to: ConnectorPoint): string {
  const verticalControl = Math.max(8, Math.abs(to.y - from.y) * 0.5);
  return `C ${from.x} ${from.y + verticalControl} ${to.x} ${to.y - verticalControl} ${to.x} ${to.y}`;
}

export function treeConnectorPath(points: ConnectorPoint[]): string {
  const first = points[0];
  if (!first) return '';
  const segments = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) continue;
    segments.push(to.x >= from.x ? `L ${to.x} ${to.y}` : outdentCurve(from, to));
  }
  return segments.join(' ');
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function attachTreeConnector(tree: HTMLElement): { destroy(): void } {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  svg.classList.add('tree-connector');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  tree.prepend(svg);

  let animationFrame = 0;
  const draw = () => {
    animationFrame = 0;
    const treeBounds = tree.getBoundingClientRect();
    const points = [...tree.querySelectorAll<HTMLElement>('.graph-node-dot')].map((dot) => {
      const bounds = dot.getBoundingClientRect();
      return {
        x: bounds.left + bounds.width / 2 - treeBounds.left,
        y: bounds.top + bounds.height / 2 - treeBounds.top,
      };
    });
    svg.setAttribute('viewBox', `0 0 ${treeBounds.width} ${treeBounds.height}`);
    svg.setAttribute('width', String(treeBounds.width));
    svg.setAttribute('height', String(treeBounds.height));
    path.setAttribute('d', treeConnectorPath(points));
  };
  const scheduleDraw = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(draw);
  };
  const resizeObserver = new ResizeObserver(scheduleDraw);
  const mutationObserver = new MutationObserver(scheduleDraw);
  resizeObserver.observe(tree);
  mutationObserver.observe(tree, { childList: true, subtree: true });
  scheduleDraw();

  return {
    destroy() {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      svg.remove();
    },
  };
}