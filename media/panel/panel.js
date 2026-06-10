// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @typedef {{ command: string, title: string, description?: string, args?: unknown[], enabled?: boolean }} Action */
  /** @typedef {{ kind: string, id: string, label: string, description?: string,
   *              tooltip?: string, icon?: string, openUri?: string,
   *              actions?: Action[], children?: any[], collapsible?: boolean,
   *              status?: 'open'|'closed', recentEntryCount?: number }} Node */
  /** @typedef {{ type: 'card.unfocus', slug: string, topicSlug: string }} CardUnfocusMessage */
  /** @typedef {{ type: 'invoke', command: string, args: unknown[] }} InvokeMessage */
  /** @typedef {CardUnfocusMessage | InvokeMessage} ContextMenuMessage */
  /** @typedef {{ label: string, enabled: boolean, message?: ContextMenuMessage, children?: ContextMenuItem[] }} ContextMenuItem */
  /** @typedef {{ tab: 'active'|'archive'|'topics', items: Node[],
   *              emptyMessage: string }} TabData */

  /**
   * Deterministically map a workstream node id to one of the card color
   * slots (0..14). Stable across reloads so each
   * workstream keeps the same color.
   * @param {string} id
   * @returns {number}
   */
  function colorIndexForId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 15;
  }

  // --- Icons ------------------------------------------------------------
  //
  // The webview loads the official VS Code codicon font (`media/codicons/`,
  // see panelProvider.ts → renderHtml). Any codicon id from
  // https://microsoft.github.io/vscode-codicons/dist/codicon.html
  // can be rendered as `<span class="codicon codicon-<name>"></span>`.
  // Missing/empty names render nothing — no broken-glyph fallback.

  /**
   * Build a codicon span element for the given name.
   * @param {string | undefined | null} name
   * @returns {HTMLElement | null}
   */
  function makeCodicon(name) {
    if (!name) {
      return null;
    }
    const el = document.createElement('span');
    el.className = 'codicon codicon-' + name;
    return el;
  }

  // --- State ------------------------------------------------------------

  const persisted =
    /** @type {{ activeTab?: 'active'|'archive'|'topics', expanded?: string[] } | undefined} */ (
      vscode.getState()
    );

  /** @type {{ activeTab: 'active'|'archive'|'topics', expanded: Set<string>,
   *           data: { active?: TabData, archive?: TabData, topics?: TabData },
   *           focusedId: string | null, recentCounts: Map<string, number>,
   *           flashChipIds: Set<string> }} */
  const state = {
    activeTab:
      persisted?.activeTab === 'archive' || persisted?.activeTab === 'topics'
        ? persisted.activeTab
        : 'active',
    expanded: new Set(Array.isArray(persisted?.expanded) ? persisted.expanded : []),
    data: {},
    focusedId: null,
    recentCounts: new Map(),
    flashChipIds: new Set(),
  };

  function persist() {
    vscode.setState({
      activeTab: state.activeTab,
      expanded: Array.from(state.expanded),
    });
  }

  // --- Rendering --------------------------------------------------------

  const listEl = /** @type {HTMLElement} */ (document.getElementById('list'));
  const tabsEl = /** @type {HTMLElement} */ (document.querySelector('.tabs'));
  const CONTEXT_MENU_MARGIN = 6;
  const contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'context-menu';
  contextMenuEl.hidden = true;
  document.body.appendChild(contextMenuEl);

  /**
   * @param {string | undefined} openUri
   * @returns {string | null}
   */
  function workstreamSlugFromOpenUri(openUri) {
    if (!openUri) {
      return null;
    }
    const match = /^working-memory:\/workstream\/(.+)\.md$/.exec(openUri);
    if (!match || !match[1]) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  /**
   * @param {string | undefined} openUri
   * @returns {string | null}
   */
  function topicSlugFromOpenUri(openUri) {
    if (!openUri) {
      return null;
    }
    const match = /^working-memory:\/topic\/(.+)\.md$/.exec(openUri);
    if (!match || !match[1]) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  /**
   * @param {Node & { focused_topics?: unknown[] }} card
   * @param {string | null} topicSlug
   * @returns {ContextMenuItem[]}
   */
  function cardContextMenu(card, topicSlug) {
    const slug = workstreamSlugFromOpenUri(card.openUri);
    if (!slug || !topicSlug) {
      return [];
    }
    return [
      {
        label: 'Remove from Focus',
        enabled: true,
        message: {
          type: 'card.unfocus',
          slug,
          topicSlug,
        },
      },
    ];
  }

  /**
   * @param {Node} node
   * @param {HTMLElement} row
   * @returns {ContextMenuItem[]}
   */
  function rowContextMenu(node, row) {
    if (!Array.isArray(node.actions) || node.actions.length === 0) {
      return [];
    }
    const updateItems = node.actions.map((action) => ({
      label: action.title,
      enabled: action.enabled !== false,
      message: {
        type: 'invoke',
        command: action.command,
        args: Array.isArray(action.args) ? action.args : [],
      },
    }));
    const focusedContext = focusedMenuContext(node, row);
    if (!focusedContext) {
      return updateItems;
    }
    return [
      {
        label: 'Remove from Focus',
        enabled: true,
        message: {
          type: 'card.unfocus',
          slug: focusedContext.workstreamSlug,
          topicSlug: focusedContext.topicSlug,
        },
      },
      {
        label: 'Update Workstream…',
        enabled: true,
        children: updateItems,
      },
    ];
  }

  /**
   * Resolve the focused-topic context needed for "Remove from Focus".
   * Returns null for non-focused rows or rows without enough slug context.
   * @param {Node} node
   * @param {HTMLElement} row
   * @returns {{ workstreamSlug: string, topicSlug: string } | null}
   */
  function focusedMenuContext(node, row) {
    const card = row.closest('.ws-card');
    const workstreamSlug =
      row.dataset.workstreamSlug ?? card?.dataset.workstreamSlug ?? null;
    if (!workstreamSlug) {
      return null;
    }
    const topicSlugFromNode =
      node.kind === 'topic' || node.kind === 'topic-row'
        ? topicSlugFromOpenUri(node.openUri)
        : null;
    const topicSlug = row.dataset.topicSlug ?? topicSlugFromNode;
    if (!topicSlug) {
      return null;
    }
    return { workstreamSlug, topicSlug };
  }

  /**
   * @param {MouseEvent} event
   * @param {Node & { focused_topics?: unknown[] }} card
   */
  function openCardContextMenu(event, card) {
    const target = event.target;
    const pinnedRow = target instanceof Element
      ? target.closest('.pinned-focused')
      : null;
    const topicSlug = pinnedRow instanceof HTMLElement
      ? pinnedRow.dataset.topicSlug ?? null
      : null;
    const items = cardContextMenu(card, topicSlug);
    openContextMenu(event, items);
  }

  /**
   * @param {MouseEvent} event
   * @param {Node} node
   * @param {HTMLElement} row
   */
  function openRowContextMenu(event, node, row) {
    openContextMenu(event, rowContextMenu(node, row));
  }

  /**
   * @param {ContextMenuItem} item
   */
  function runContextMenuItem(item) {
    if (!item.enabled || !item.message) {
      return;
    }
    closeContextMenu();
    vscode.postMessage(item.message);
  }

  /**
   * @param {MouseEvent} event
   * @param {ContextMenuItem[]} items
   */
  function openContextMenu(event, items) {
    if (items.length === 0) {
      closeContextMenu();
      return;
    }
    contextMenuEl.replaceChildren();
    for (const item of items) {
      const entry = document.createElement('div');
      entry.className = 'context-menu-entry';
      const btn = document.createElement('button');
      btn.className = 'context-menu-item';
      btn.type = 'button';
      btn.disabled = !item.enabled;
      btn.textContent = item.label;
      const hasSubmenu = Array.isArray(item.children) && item.children.length > 0;
      if (hasSubmenu) {
        // Parent submenu rows are navigational only; executable actions live in
        // leaf items (children) so no command message is posted from parent.
        btn.classList.add('has-submenu');
        btn.setAttribute('aria-haspopup', 'true');
        const indicator = document.createElement('span');
        indicator.className = 'context-submenu-indicator';
        const chevron = makeCodicon('chevron-right');
        if (chevron) {
          indicator.appendChild(chevron);
        }
        btn.appendChild(indicator);
        const submenu = document.createElement('div');
        submenu.className = 'context-submenu';
        for (const child of item.children) {
          const childBtn = document.createElement('button');
          childBtn.className = 'context-menu-item';
          childBtn.type = 'button';
          childBtn.disabled = !child.enabled;
          childBtn.textContent = child.label;
          childBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            runContextMenuItem(child);
          });
          submenu.appendChild(childBtn);
        }
        entry.appendChild(btn);
        entry.appendChild(submenu);
      } else {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          runContextMenuItem(item);
        });
        entry.appendChild(btn);
      }
      contextMenuEl.appendChild(entry);
    }
    contextMenuEl.hidden = false;

    const maxLeft = Math.max(
      CONTEXT_MENU_MARGIN,
      window.innerWidth - contextMenuEl.offsetWidth - CONTEXT_MENU_MARGIN,
    );
    const maxTop = Math.max(
      CONTEXT_MENU_MARGIN,
      window.innerHeight - contextMenuEl.offsetHeight - CONTEXT_MENU_MARGIN,
    );
    const left = Math.min(Math.max(event.clientX, CONTEXT_MENU_MARGIN), maxLeft);
    const top = Math.min(Math.max(event.clientY, CONTEXT_MENU_MARGIN), maxTop);
    contextMenuEl.style.left = left + 'px';
    contextMenuEl.style.top = top + 'px';
    positionContextSubmenus();
  }

  function positionContextSubmenus() {
    const entries = contextMenuEl.querySelectorAll('.context-menu-entry');
    for (const entry of entries) {
      if (!(entry instanceof HTMLElement)) {
        continue;
      }
      const submenu = entry.querySelector(':scope > .context-submenu');
      if (!(submenu instanceof HTMLElement)) {
        continue;
      }
      submenu.classList.remove('context-submenu-left');
      submenu.style.top = '-4px';
      submenu.style.minWidth = '';
      submenu.style.maxWidth = '';

      // Submenus are display:none by default; temporarily expose for size
      // measurement so we can keep them inside the viewport.
      submenu.style.visibility = 'hidden';
      submenu.style.display = 'flex';
      const submenuWidth = submenu.offsetWidth;
      const submenuHeight = submenu.offsetHeight;
      submenu.style.display = '';
      submenu.style.visibility = '';

      const entryRect = entry.getBoundingClientRect();
      const spaceRight = window.innerWidth - entryRect.right - CONTEXT_MENU_MARGIN;
      const spaceLeft = entryRect.left - CONTEXT_MENU_MARGIN;
      const fitsRight = spaceRight >= submenuWidth;
      const fitsLeft = spaceLeft >= submenuWidth;

      const openLeft = !fitsRight && (fitsLeft || spaceLeft > spaceRight);
      if (openLeft) {
        submenu.classList.add('context-submenu-left');
      }
      if (!fitsRight && !fitsLeft) {
        const constrainedWidth = Math.max(
          120,
          Math.floor(Math.max(spaceLeft, spaceRight)),
        );
        submenu.style.minWidth = '0';
        submenu.style.maxWidth = constrainedWidth + 'px';
      }

      let top = -4;
      const overflowBottom =
        entryRect.top + top + submenuHeight + CONTEXT_MENU_MARGIN - window.innerHeight;
      if (overflowBottom > 0) {
        top -= overflowBottom;
      }
      const overflowTop = CONTEXT_MENU_MARGIN - (entryRect.top + top);
      if (overflowTop > 0) {
        top += overflowTop;
      }
      submenu.style.top = Math.round(top) + 'px';
    }
  }

  function closeContextMenu() {
    contextMenuEl.hidden = true;
    contextMenuEl.replaceChildren();
  }

  /**
   * Build the row element for a node — no children, no recursion. Returned
   * element is detached; caller decides where to put it.
   * @param {Node} node
   * @param {number} depth
   * @returns {HTMLElement}
   */
  function renderRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'treeitem');
    row.dataset.id = node.id;
    if (node.tooltip) {
      row.title = node.tooltip;
    }
    row.style.paddingLeft = (depth * 12 + 4) + 'px';
    if (state.focusedId === node.id) {
      row.classList.add('focused');
    }
    // Mute closed topic rows so the eye skips past them. Children render as
    // sibling DOM rows (not nested), so this opacity does not bleed into
    // open child topics under a closed parent.
    if (
      (node.kind === 'topic' || node.kind === 'topic-row') &&
      node.status === 'closed'
    ) {
      row.classList.add('is-closed');
    }

    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;
    const expanded = state.expanded.has(node.id);

    // Twisty — chevron-right that we rotate 90° via CSS when expanded.
    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (hasChildren ? ' collapsible' : ' leaf') +
      (expanded ? ' expanded' : '');
    const twistyIcon = makeCodicon('chevron-right');
    if (twistyIcon) {
      twisty.appendChild(twistyIcon);
    }
    if (hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(node.id);
      });
    }
    row.appendChild(twisty);

    // Icon
    if (node.icon) {
      const wrap = document.createElement('span');
      wrap.className = 'icon';
      const iconEl = makeCodicon(node.icon);
      if (iconEl) {
        wrap.appendChild(iconEl);
      }
      row.appendChild(wrap);
    }

    // Label
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    row.appendChild(label);

    // Description
    if (node.description) {
      const desc = document.createElement('span');
      desc.className = 'description';
      desc.textContent = node.description;
      row.appendChild(desc);
    }

    // Recent entries chip
    const recentEntryCount =
      typeof node.recentEntryCount === 'number' ? node.recentEntryCount : 0;
    if (recentEntryCount > 0) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip' +
        (state.flashChipIds.has(node.id) ? ' flash' : '');
      chip.textContent = String(recentEntryCount);
      chip.title =
        `${recentEntryCount} entr${recentEntryCount === 1 ? 'y' : 'ies'} — click to view`;
      chip.setAttribute(
        'aria-label',
        `${recentEntryCount} entr${recentEntryCount === 1 ? 'y' : 'ies'} — click to view`,
      );
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const revealSection = node.kind === 'workstream'
          ? 'sessions'
          : node.kind === 'session'
            ? 'entries'
            : node.kind === 'topic' || node.kind === 'topic-row'
              ? 'recent-entries'
              : null;
        state.focusedId = node.id;
        if (node.openUri) {
          vscode.postMessage({
            type: 'open',
            uri: node.openUri,
            revealSection,
          });
          render();
        }
      });
      row.appendChild(chip);
    }

    // Actions
    if (Array.isArray(node.actions) && node.actions.length > 0) {
      const actions = document.createElement('span');
      actions.className = 'actions';
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.type = 'button';
      btn.title = 'More actions…';
      btn.setAttribute('aria-label', 'More actions');
      const moreIcon = makeCodicon('ellipsis');
      if (moreIcon) {
        btn.appendChild(moreIcon);
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRowContextMenu(e, node, row);
      });
      actions.appendChild(btn);
      row.appendChild(actions);
    }

    // Click / activation
    row.addEventListener('click', () => {
      state.focusedId = node.id;
      if (node.openUri) {
        vscode.postMessage({ type: 'open', uri: node.openUri });
      } else if (hasChildren) {
        toggle(node.id);
      } else {
        render();
      }
    });

    if (
      (node.kind === 'topic' || node.kind === 'topic-row') &&
      Array.isArray(node.actions) &&
      node.actions.length > 0
    ) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openRowContextMenu(event, node, row);
      });
    }

    return row;
  }

  /**
   * Append a row plus its expanded subtree to a target element/fragment.
   * @param {Node} node
   * @param {number} depth
   * @param {HTMLElement | DocumentFragment} target
   */
  function renderNode(node, depth, target) {
    target.appendChild(renderRow(node, depth));
    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;
    if (hasChildren && state.expanded.has(node.id)) {
      for (const child of node.children) {
        renderNode(child, depth + 1, target);
      }
    }
  }

  function toggle(id) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
    } else {
      state.expanded.add(id);
    }
    persist();
    render();
  }

  /**
   * Build a pinned-focused-topic row for a workstream card. Clones the
   * underlying PanelTopic node, prefixes its id so expand-state of the
   * normal topic row isn't shared, and leads with a pin codicon to mark
   * it as the focused / quick-access slot.
   * @param {Node} topic
   * @param {Node & { openUri?: string }} workstream
   * @returns {HTMLElement}
   */
  function renderPinnedFocusedTopic(topic, workstream) {
    const clone = /** @type {Node} */ ({
      ...topic,
      id: 'pinned:' + topic.id,
      children: undefined,
    });
    const row = renderRow(clone, 1);
    row.classList.add('pinned-focused');
    const topicSlug = topicSlugFromOpenUri(topic.openUri);
    if (topicSlug) {
      row.dataset.topicSlug = topicSlug;
    }
    const workstreamSlug = workstreamSlugFromOpenUri(workstream.openUri);
    if (workstreamSlug) {
      row.dataset.workstreamSlug = workstreamSlug;
    }
    // Prepend a pin codicon before the existing icon so the marker is the
    // first thing the eye lands on. Insert after the twisty (first child)
    // so indentation stays aligned with sibling rows.
    const pin = document.createElement('span');
    pin.className = 'pin-marker';
    const pinIcon = makeCodicon('pin');
    if (pinIcon) {
      pin.appendChild(pinIcon);
    }
    const twisty = row.firstChild;
    if (twisty && twisty.nextSibling) {
      row.insertBefore(pin, twisty.nextSibling);
    } else {
      row.appendChild(pin);
    }
    return row;
  }

  function render() {
    // Tabs
    const tabButtons = tabsEl.querySelectorAll('.tab');
    tabButtons.forEach((btn) => {
      const t = btn.getAttribute('data-tab');
      const selected = t === state.activeTab;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });

    // List
    listEl.replaceChildren();
    listEl.classList.toggle('cards', state.activeTab === 'active');
    const data = state.data[state.activeTab];
    if (!data || data.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = data ? data.emptyMessage : '';
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    if (state.activeTab === 'active') {
      // Each top-level workstream renders as its own collapsible card.
      // Header is the workstream row itself; body holds the nested subtree.
      for (const item of data.items) {
        const card = document.createElement('div');
        card.className = 'ws-card ws-card-color-' + colorIndexForId(item.id);
        const workstreamSlug = workstreamSlugFromOpenUri(item.openUri);
        if (workstreamSlug) {
          card.dataset.workstreamSlug = workstreamSlug;
        }
        const expanded = state.expanded.has(item.id);
        if (expanded) {
          card.classList.add('expanded');
        }

        const header = document.createElement('div');
        header.className = 'ws-card-header';
        header.appendChild(renderRow(item, 0));
        card.appendChild(header);

        const hasChildren =
          Array.isArray(item.children) && item.children.length > 0;
        const focusedTopics = Array.isArray(item.focused_topics)
          ? item.focused_topics
          : [];
        if (hasChildren || focusedTopics.length > 0) {
          const body = document.createElement('div');
          body.className = 'ws-card-body';
          if (!expanded) {
            body.hidden = true;
          } else {
            // Pinned focused-topic row(s) render first, above the normal
            // topics group / sessions. They're a duplicate quick-access
            // surface; the topic still appears in its regular slot below.
            for (const ft of focusedTopics) {
              const pinned = renderPinnedFocusedTopic(ft, item);
              body.appendChild(pinned);
            }
            for (const child of item.children) {
              renderNode(child, 1, body);
            }
          }
          card.appendChild(body);
        }

        card.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openCardContextMenu(event, item);
        });

        frag.appendChild(card);
      }
    } else {
      for (const item of data.items) {
        renderNode(item, 0, frag);
      }
    }
    listEl.appendChild(frag);
    state.flashChipIds.clear();
  }

  // --- Event wiring -----------------------------------------------------

  tabsEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('.tab');
    if (!btn) {
      return;
    }
    const t = btn.getAttribute('data-tab');
    if (t !== 'active' && t !== 'archive' && t !== 'topics') {
      return;
    }
    if (state.activeTab === t) {
      return;
    }
    state.activeTab = t;
    state.focusedId = null;
    closeContextMenu();
    persist();
    render();
  });

  document.addEventListener('click', (e) => {
    if (contextMenuEl.hidden) {
      return;
    }
    const target = e.target;
    if (!(target instanceof Element) || !contextMenuEl.contains(target)) {
      closeContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContextMenu();
    }
  });

  document.addEventListener(
    'scroll',
    () => {
      closeContextMenu();
    },
    true,
  );

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'data') {
      // Drop expanded ids that no longer exist in the new dataset to keep
      // the Set from growing unbounded across many refreshes.
      /** @type {Set<string>} */
      const liveIds = new Set();
      const visit = (n) => {
        liveIds.add(n.id);
        if (Array.isArray(n.children)) {
          for (const c of n.children) {
            visit(c);
          }
        }
      };
      for (const tab of /** @type {const} */ (['active', 'archive', 'topics'])) {
        const td = msg.data?.[tab];
        if (td?.items) {
          for (const w of td.items) {
            visit(w);
          }
        }
      }
      for (const id of Array.from(state.expanded)) {
        if (!liveIds.has(id)) {
          state.expanded.delete(id);
        }
      }
      /** @type {Map<string, number>} */
      const nextRecentCounts = new Map();
      /** @type {Set<string>} */
      const flashChipIds = new Set();
      const collectRecent = (n) => {
        const count = typeof n.recentEntryCount === 'number' ? n.recentEntryCount : 0;
        nextRecentCounts.set(n.id, count);
        const previous = state.recentCounts.get(n.id) ?? 0;
        if (count > previous) {
          flashChipIds.add(n.id);
        }
        if (Array.isArray(n.focused_topics)) {
          for (const ft of n.focused_topics) {
            collectRecent(ft);
          }
        }
        if (Array.isArray(n.children)) {
          for (const c of n.children) {
            collectRecent(c);
          }
        }
      };
      for (const tab of /** @type {const} */ (['active', 'archive', 'topics'])) {
        const td = msg.data?.[tab];
        if (td?.items) {
          for (const n of td.items) {
            collectRecent(n);
          }
        }
      }
      state.recentCounts = nextRecentCounts;
      state.flashChipIds = flashChipIds;
      state.data = msg.data || {};
      closeContextMenu();
      render();
    }
  });

  // Request initial data.
  vscode.postMessage({ type: 'ready' });
})();
