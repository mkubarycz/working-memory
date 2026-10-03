export interface ChatRunFocusTarget extends Element {
  focus(options?: FocusOptions): void;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

export interface ChatRunFocusDependencies {
  activateLog(): void;
  expandChatRail(): void;
  afterRender(): Promise<void>;
  getTarget(): ChatRunFocusTarget | null;
  waitForScrollEnd(scroller: Element): Promise<void>;
  restartAttention(target: HTMLElement): void;
}

export async function focusChatRunTarget(dependencies: ChatRunFocusDependencies): Promise<void> {
  dependencies.activateLog();
  dependencies.expandChatRail();
  await dependencies.afterRender();

  const target = dependencies.getTarget();
  if (!target) return;
  const scroller = target.closest('.conversation');
  const targetBounds = target.getBoundingClientRect();
  const scrollerBounds = scroller?.getBoundingClientRect();
  const needsScroll = scrollerBounds
    ? Math.abs(targetBounds.top + targetBounds.height / 2 - (scrollerBounds.top + scrollerBounds.height / 2)) > 1
    : false;
  const scrollFinished = scroller && needsScroll
    ? dependencies.waitForScrollEnd(scroller)
    : Promise.resolve();
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await scrollFinished;
  target.focus({ preventScroll: true });
  dependencies.restartAttention(target as HTMLElement);
}
