// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @typedef {{ command: string, title: string, description?: string, args?: unknown[], enabled?: boolean }} Action */
  /** @typedef {{ kind: string, id: string, label: string, description?: string,
   *              tooltip?: string, icon?: string, openUri?: string,
   *              actions?: Action[], children?: any[], collapsible?: boolean,
   *              status?: 'open'|'closed', recentEntryCount?: number,
   *              focused?: boolean }} Node */
  /** @typedef {{ type: 'card.unfocus', slug: string, topicSlug: string }} CardUnfocusMessage */
  /** @typedef {{ type: 'card.focus', slug: string, topicSlug: string }} CardFocusMessage */
  /** @typedef {{ type: 'invoke', command: string, args: unknown[] }} InvokeMessage */
  /** @typedef {CardUnfocusMessage | CardFocusMessage | InvokeMessage} ContextMenuMessage */
  /** @typedef {{ label: string, enabled: boolean, icon?: string, message?: ContextMenuMessage, children?: ContextMenuItem[] }} ContextMenuItem */
  /** @typedef {{ tab: 'active'|'archive'|'topics'|'topic-types', items: Node[],
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

  /**
   * Fill a context-menu button with an optional leading move-direction icon
   * followed by its label. When no icon is set, the label is rendered alone.
   * @param {HTMLElement} btn
   * @param {ContextMenuItem} item
   */
  function fillContextMenuItem(btn, item) {
    const icon = item.icon ? makeCodicon(item.icon) : null;
    if (icon) {
      icon.classList.add('context-menu-icon');
      btn.appendChild(icon);
    }
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = item.label;
    btn.appendChild(label);
  }

  // --- State ------------------------------------------------------------

  const persisted =
    /** @type {{ activeTab?: 'active'|'archive'|'topics'|'topic-types'|'alerts', expanded?: string[] } | undefined} */ (
      vscode.getState()
    );

  /** @type {{ activeTab: 'active'|'archive'|'topics'|'topic-types'|'alerts', expanded: Set<string>,
   *           data: { active?: TabData, archive?: TabData, topics?: TabData, topicTypes?: TabData, alerts?: TabData },
   *           focusedId: string | null, recentCounts: Map<string, number>,
   *           flashChipIds: Set<string> }} */
  const state = {
    activeTab:
      persisted?.activeTab === 'archive' ||
      persisted?.activeTab === 'topics' ||
      persisted?.activeTab === 'topic-types' ||
      persisted?.activeTab === 'alerts'
        ? persisted.activeTab
        : 'active',
    expanded: new Set(Array.isArray(persisted?.expanded) ? persisted.expanded : []),
    data: {},
    focusedId: null,
    recentCounts: new Map(),
    flashChipIds: new Set(),
    /** @type {{ kind: string, id: string } | null} Latest reveal target from the host. */
    revealTarget: null,
  };

  function persist() {
    vscode.setState({
      activeTab: state.activeTab,
      expanded: Array.from(state.expanded),
    });
  }

  /**
   * @param {'active'|'archive'|'topics'|'topic-types'} tab
   * @returns {TabData | undefined}
   */
  function getTabData(tab) {
    if (tab === 'topic-types') {
      return state.data.topicTypes;
    }
    return state.data[tab];
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
    /** @type {ContextMenuItem[]} */
    const items = [];
    if (slug && topicSlug) {
      items.push({
        label: 'Remove from Focus',
        enabled: true,
        message: {
          type: 'card.unfocus',
          slug,
          topicSlug,
        },
      });
    }
    // Section-move actions ("Send to Queue" / "Send to Backlog" / etc.) come
    // from the host-populated node.actions for the active tab.
    items.push(...workstreamActionsMenu(card));
    return items;
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
      icon: action.icon,
      message: {
        type: 'invoke',
        command: action.command,
        args: Array.isArray(action.args) ? action.args : [],
      },
    }));
    const topicContext = workstreamTopicContext(node, row);
    if (!topicContext) {
      return updateItems;
    }
    const focusItem = topicContext.focused
      ? {
        label: 'Remove from Focus',
        enabled: true,
        message: {
          type: 'card.unfocus',
          slug: topicContext.workstreamSlug,
          topicSlug: topicContext.topicSlug,
        },
      }
      : {
        label: 'Add to Focus',
        enabled: true,
        message: {
          type: 'card.focus',
          slug: topicContext.workstreamSlug,
          topicSlug: topicContext.topicSlug,
        },
      };
    return [
      focusItem,
      {
        label: 'Update Workstream…',
        enabled: true,
        children: updateItems,
      },
    ];
  }

  /**
   * Resolve the workstream topic context needed for focus actions.
   * Returns null for rows without enough slug context.
   * @param {Node} node
   * @param {HTMLElement} row
   * @returns {{ workstreamSlug: string, topicSlug: string, focused: boolean } | null}
   */
  function workstreamTopicContext(node, row) {
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
    const focused =
      node.kind === 'topic' || node.kind === 'topic-row'
        ? node.focused === true
        : false;
    return { workstreamSlug, topicSlug, focused };
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
      fillContextMenuItem(btn, item);
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
          fillContextMenuItem(childBtn, child);
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
    // Passive reveal highlight — bold + yellow text on the row whose WM doc is
    // currently open in the editor. Re-applied on every render so it persists
    // across manual tab switches and data refreshes, and lands on every
    // occurrence (tree node + pinned/focused clone). Independent of `.focused`.
    if (nodeMatchesReveal(node)) {
      row.classList.add('revealed');
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

    // Alert count bubble (A/C) — reddish if any alert-status, default if all
    // informational, hidden when zero open.
    const alertCount =
      typeof node.alertCount === 'number' ? node.alertCount : 0;
    if (alertCount > 0) {
      const bubble = document.createElement('span');
      bubble.className =
        'alert-bubble' +
        (node.alertSeverity === 'alert' ? ' severe' : ' info');
      bubble.textContent = String(alertCount);
      bubble.title =
        `${alertCount} open alert${alertCount === 1 ? '' : 's'}`;
      row.appendChild(bubble);
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

  /**
   * Build one full workstream card (Progress section + Archive-style detail).
   * Extracted from the old inline active-tab loop so both the Progress section
   * and any future card surface can reuse it.
   * @param {Node & { focused_topics?: Node[] }} item
   * @returns {HTMLElement}
   */
  function renderWorkstreamCard(item) {
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
    return card;
  }

  /**
   * Build the ContextMenuItem[] for a workstream's "send to section" actions
   * (sourced from node.actions, which the host populates for the active tab).
   * @param {Node} ws
   * @returns {ContextMenuItem[]}
   */
  function workstreamActionsMenu(ws) {
    const actions = Array.isArray(ws.actions) ? ws.actions : [];
    return actions.map((a) => ({
      label: a.title,
      enabled: a.enabled !== false,
      icon: a.icon,
      message: {
        type: 'invoke',
        command: a.command,
        args: Array.isArray(a.args) ? a.args : [],
      },
    }));
  }

  /**
   * Promote a workstream straight into the Progress section. Used by
   * click-to-promote on Queue / Backlog shelf items.
   * @param {Node} ws
   */
  function promoteWorkstream(ws) {
    const slug = workstreamSlugFromOpenUri(ws.openUri);
    if (!slug) {
      return;
    }
    closeContextMenu();
    vscode.postMessage({
      type: 'invoke',
      command: 'working-memory.setWorkstreamSection',
      args: [{ slug, section: 'progress' }],
    });
  }

  /**
   * Build a compact single-line row for a Queue / Backlog shelf item.
   * Clicking the row opens the workstream doc; a leading move-to button
   * promotes it to Progress; right-click opens the section-move menu.
   * @param {Node} ws
   * @param {'up' | 'down'} [direction] Direction the move-to button promotes
   *   the item toward the Progress stage. Queue sits above Progress → 'down';
   *   Backlog sits below → 'up'. Controls which arrow codicon is shown.
   * @returns {HTMLElement}
   */
  function renderShelfItem(ws, direction = 'down') {
    const el = document.createElement('div');
    el.className = 'ws-shelf-item';
    const slug = workstreamSlugFromOpenUri(ws.openUri);
    if (slug) {
      el.dataset.workstreamSlug = slug;
    }
    if (nodeMatchesReveal(ws)) {
      el.classList.add('revealed');
    }

    // Leading move-to button: promotes the item straight into Progress.
    // Directional glyph — Queue is above Progress (move DOWN), Backlog below
    // (move UP). Sits in front of the label, replacing the old leading icon.
    const move = document.createElement('button');
    move.className = 'ws-shelf-move';
    move.type = 'button';
    move.title = 'Send to In Progress';
    move.setAttribute('aria-label', 'Send to In Progress');
    const moveIcon = makeCodicon(
      direction === 'up' ? 'arrow-circle-up' : 'arrow-circle-down'
    );
    if (moveIcon) {
      move.appendChild(moveIcon);
    }
    move.addEventListener('click', (event) => {
      event.stopPropagation();
      promoteWorkstream(ws);
    });
    el.appendChild(move);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = ws.label;
    el.appendChild(label);

    const recentEntryCount =
      typeof ws.recentEntryCount === 'number' ? ws.recentEntryCount : 0;
    if (recentEntryCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'recent-chip';
      chip.textContent = String(recentEntryCount);
      el.appendChild(chip);
    }

    el.title = (ws.tooltip ? ws.tooltip + '\n' : '') + 'Click to open';
    el.addEventListener('click', () => {
      if (typeof ws.openUri === 'string' && ws.openUri) {
        vscode.postMessage({ type: 'open', uri: ws.openUri });
      }
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openContextMenu(event, workstreamActionsMenu(ws));
    });
    return el;
  }

  /**
   * Build the thin pull-handle affordance for a shelf. A small grip pill that
   * toggles the deck open/closed. Only rendered when there's more than one
   * item to reveal. For Queue it sits at the bottom edge of the content
   * column (nearest the In Progress stage below), for Backlog at the top edge
   * (nearest the In Progress stage above).
   * @param {Node & { id: string, label?: string }} section
   * @returns {HTMLElement}
   */
  function makeShelfHandle(section) {
    const pull = document.createElement('div');
    pull.className = 'ws-shelf-pull';
    pull.setAttribute('role', 'button');
    const open = state.expanded.has(section.id);
    pull.setAttribute('aria-expanded', open ? 'true' : 'false');
    pull.title = (open ? 'Collapse ' : 'Expand ') + (section.label || '');
    const grip = document.createElement('span');
    grip.className = 'ws-shelf-grip';
    pull.appendChild(grip);
    pull.addEventListener('click', () => toggle(section.id));
    return pull;
  }

  /**
   * Build a Queue / Backlog peek shelf. The shelf is a horizontal flex row: a
   * thin vertical label rail on the LEFT (the section label + count rotated
   * to read along the left edge) and a content column on the RIGHT holding
   * the deck/list plus a thin pull-handle. Collapsed renders the two newest
   * workstreams as normal compact rows stacked in flow with up to two faded,
   * offset decorative slivers fanning DOWN behind/below them to imply a stack
   * (a "peek deck") — identical for both shelves. The pull-handle sits adjacent to the
   * In Progress stage (bottom of Queue, top of Backlog) and is the
   * expand/collapse toggle; the vertical rail also toggles. Expanding reveals
   * the full list of compact rows: Queue newest-at-bottom (reversed), Backlog
   * newest-at-top (normal).
   * @param {Node & { workstreams?: Node[], emptyMessage?: string, label?: string, section?: string }} section
   * @returns {HTMLElement}
   */
  function renderShelf(section) {
    const shelf = document.createElement('div');
    shelf.className = 'ws-shelf';
    const items = Array.isArray(section.workstreams) ? section.workstreams : [];
    const expanded = state.expanded.has(section.id);
    // Backlog is the vertical mirror of Queue (flipped about the In Progress
    // stage between them). Queue's handle sits at its BOTTOM (nearest the
    // Progress stage below it) with the deck above; Backlog's handle sits at
    // its TOP (nearest the Progress stage above it) with the deck below.
    // The content column orders the handle relative to the body accordingly.
    const isBacklog = section.section === 'backlog';

    // The rail + handle are the expand/collapse affordance. They're only
    // interactive when there's more than two items to reveal. With two or
    // fewer items everything fits, so we render a plain full list with a
    // static rail (no peek-deck, no collapse); zero items renders an empty
    // notice.
    const canToggle = items.length > 2;

    // Vertical label rail pinned to the left edge of the shelf. The label
    // text + count are rotated to read along the edge (see panel.css). The
    // rail also toggles the deck when there's something to expand.
    const rail = document.createElement('div');
    rail.className = 'ws-shelf-rail' + (canToggle ? '' : ' ws-shelf-rail-static');
    const railText = document.createElement('div');
    railText.className = 'ws-shelf-rail-text';
    const railLabel = document.createElement('span');
    railLabel.className = 'ws-section-label';
    railLabel.textContent = section.label || '';
    railText.appendChild(railLabel);
    const railCount = document.createElement('span');
    railCount.className = 'ws-section-count';
    railCount.textContent = String(items.length);
    railText.appendChild(railCount);
    rail.appendChild(railText);
    if (canToggle) {
      rail.addEventListener('click', () => toggle(section.id));
    }

    // Content column on the right of the rail — holds the deck/list/empty
    // notice plus (when toggleable) the thin pull-handle.
    const content = document.createElement('div');
    content.className = 'ws-shelf-content';

    // Build the shelf body (empty notice, expanded list, or collapsed deck)
    // into `body`, then place it relative to the handle based on `isBacklog`.
    /** @type {HTMLElement} */
    let body;

    if (items.length === 0) {
      body = document.createElement('div');
      body.className = 'ws-shelf-empty';
      body.textContent = section.emptyMessage || '';
      content.appendChild(body);
      shelf.appendChild(rail);
      shelf.appendChild(content);
      return shelf;
    }

    if (!canToggle || expanded) {
      // Full list: either too few items to bother collapsing (<=2, always
      // shown regardless of `state.expanded`) or a 3+ shelf the user has
      // expanded.
      const list = document.createElement('div');
      list.className = 'ws-shelf-list';
      // `items` arrives newest-first (getActivePanelData sorts each shelf by
      // last-activity-desc). Queue renders the list reversed so the newest
      // sits at the BOTTOM (nearest the Progress stage below it); Backlog
      // renders newest-first so the newest sits at the TOP.
      const ordered = isBacklog ? items : items.slice().reverse();
      const moveDir = section.section === 'backlog' ? 'up' : 'down';
      for (const ws of ordered) {
        list.appendChild(renderShelfItem(ws, moveDir));
      }
      body = list;
    } else {
      // Collapsed = peek deck. The TWO newest workstreams render as normal,
      // clickable compact shelf rows stacked in flow (newest on top); behind
      // and below the lower row, up to two faded/offset decorative slivers
      // imply the remaining items. Both shelves fan the slivers DOWN (peek
      // below the rows) — Queue and Backlog collapsed decks look identical.
      // Slivers cover the rest: 1 sliver at exactly 3 items, 2 at 4+.
      const extraLayers = Math.min(items.length - 2, 2);

      const deck = document.createElement('div');
      deck.className = 'ws-shelf-deck ws-shelf-deck-down';

      const fan = document.createElement('div');
      fan.className = 'ws-shelf-fan';
      if (extraLayers > 0) {
        fan.classList.add('ws-layers-' + extraLayers);
      }
      // Depth slivers are decorative only: aria-hidden + pointer-events:none
      // (see panel.css) so they never intercept clicks or reach a screen
      // reader. Appended first (behind), farthest layer first so DOM order
      // matches paint order; the real rows below sit above them via z-index.
      for (let i = extraLayers; i >= 1; i--) {
        const layer = document.createElement('div');
        layer.className = 'ws-shelf-layer ws-shelf-layer-' + i;
        layer.setAttribute('aria-hidden', 'true');
        fan.appendChild(layer);
      }
      // The two newest workstreams as real, clickable rows (newest on top).
      // Each is a full renderShelfItem row, so click-to-open and the
      // right-click context menu work automatically.
      const moveDir = section.section === 'backlog' ? 'up' : 'down';
      for (const ws of items.slice(0, 2)) {
        const row = renderShelfItem(ws, moveDir);
        row.classList.add('ws-shelf-deck-row');
        fan.appendChild(row);
      }

      deck.appendChild(fan);
      body = deck;
    }
    // Assemble the content column: a thin pull-handle adjacent to the In
    // Progress stage (top for Backlog, bottom for Queue) plus the body. The
    // handle is only present when the deck can actually be toggled.
    const handle = canToggle ? makeShelfHandle(section) : null;
    if (isBacklog) {
      if (handle) {
        content.appendChild(handle);
      }
      content.appendChild(body);
    } else {
      content.appendChild(body);
      if (handle) {
        content.appendChild(handle);
      }
    }
    shelf.appendChild(rail);
    shelf.appendChild(content);
    return shelf;
  }

  /**
   * Render one Active-tab section (Queue / In Progress / Backlog).
   * @param {Node & { display?: string, workstreams?: Node[], emptyMessage?: string, label?: string }} section
   * @returns {HTMLElement}
   */
  function renderWorkstreamSection(section) {
    if (section.display === 'shelf') {
      return renderShelf(section);
    }
    const wrap = document.createElement('div');
    wrap.className = 'ws-section ws-section-cards';
    // No section header for the Progress (cards) region — the "In Progress"
    // label + count chip was intentionally removed; the in-progress count is
    // surfaced as a badge on the activity-bar icon instead. The Queue/Backlog
    // shelf headers (renderShelf) are unaffected.
    const items = Array.isArray(section.workstreams) ? section.workstreams : [];

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ws-section-empty';
      empty.textContent = section.emptyMessage || '';
      wrap.appendChild(empty);
      return wrap;
    }
    for (const ws of items) {
      wrap.appendChild(renderWorkstreamCard(ws));
    }
    return wrap;
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
    const data = getTabData(state.activeTab);
    if (!data || data.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = data ? data.emptyMessage : '';
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    if (state.activeTab === 'active') {
      // Active tab is grouped into Queue / In Progress / Backlog sections.
      // Progress renders full cards; Queue & Backlog render compact peek
      // shelves. Each top-level item is a section, not a workstream.
      //
      // The sections live in a full-height flex column so Queue stays pinned
      // at the top, Backlog stays glued to the bottom edge, and the In
      // Progress card list (flex:1) takes all remaining space and scrolls
      // internally (see `.active-sections` in panel.css).
      const sections = document.createElement('div');
      sections.className = 'active-sections';
      for (const section of data.items) {
        sections.appendChild(renderWorkstreamSection(section));
      }
      frag.appendChild(sections);
    } else {
      for (const item of data.items) {
        renderNode(item, 0, frag);
      }
    }
    listEl.appendChild(frag);
    state.flashChipIds.clear();
  }

  // --- Reveal-in-panel --------------------------------------------------
  //
  // The extension host watches the active tab group and tells us which WM
  // doc is currently visible via a `reveal` message ({ kind, id } | null).
  // We do NOT switch tabs, expand ancestors, or scroll — those side effects
  // were "too much". Instead the reveal is a passive style: every row whose
  // openUri matches the target is given the `.revealed` class (bold + yellow
  // text). Because the panel only renders the *active* tab's DOM at a time,
  // the match is kept as STATE (`state.revealTarget`) and re-applied inside
  // `renderRow` on every render — so manually switching tabs naturally
  // re-highlights the same doc's rows wherever it appears, and a `data`
  // refresh preserves it too. ALL occurrences are highlighted (a topic can
  // appear both as a tree node and as a pinned/focused row under a
  // workstream); this is independent of the click-selection `.focused` style.

  /**
   * Extract the slug/id segment from a node's `working-memory:/<kind>/<id>.md`
   * openUri, regardless of kind. Used for kind-less reveal-by-slug matching.
   * @param {string | undefined} openUri
   * @returns {string | null}
   */
  function slugFromOpenUri(openUri) {
    if (typeof openUri !== 'string') {
      return null;
    }
    const m = /^working-memory:\/(?:session|topic|workstream|topic-type)\/(.+)\.md$/.exec(openUri);
    if (!m) {
      return null;
    }
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch (_e) {
      // Keep the raw segment if it isn't valid percent-encoding.
    }
    return id;
  }

  /**
   * Predicate: does this node represent the WM doc currently revealed from the
   * editor? Concrete-kind targets match the full
   * `working-memory:/<kind>/<id>.md` openUri; kind-less targets (slug recovered
   * from a tab label) match by slug/id alone. Pinned/focused clones preserve
   * the underlying topic's openUri, so they match too.
   * @param {Node} node
   * @returns {boolean}
   */
  function nodeMatchesReveal(node) {
    const target = state.revealTarget;
    if (!target || typeof target.id !== 'string') {
      return false;
    }
    if (!node || typeof node.openUri !== 'string') {
      return false;
    }
    if (typeof target.kind === 'string') {
      return node.openUri ===
        'working-memory:/' + target.kind + '/' + target.id + '.md';
    }
    return slugFromOpenUri(node.openUri) === target.id;
  }

  // --- Event wiring -----------------------------------------------------

  tabsEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('.tab');
    if (!btn) {
      return;
    }
    const t = btn.getAttribute('data-tab');
    if (t !== 'active' && t !== 'archive' && t !== 'topics' && t !== 'topic-types' && t !== 'alerts') {
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

  document.addEventListener('pointerdown', (e) => {
    if (contextMenuEl.hidden) {
      return;
    }
    const target = e.target;
    if (!(target instanceof Element) || !contextMenuEl.contains(target)) {
      closeContextMenu();
    }
  }, true);

  window.addEventListener('blur', closeContextMenu);

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
        if (Array.isArray(n.workstreams)) {
          for (const w of n.workstreams) {
            visit(w);
          }
        }
        if (Array.isArray(n.children)) {
          for (const c of n.children) {
            visit(c);
          }
        }
      };
      for (const tab of /** @type {const} */ (['active', 'archive', 'topics', 'topic-types'])) {
        const td = tab === 'topic-types' ? msg.data?.topicTypes : msg.data?.[tab];
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
        if (Array.isArray(n.workstreams)) {
          for (const w of n.workstreams) {
            collectRecent(w);
          }
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
      for (const tab of /** @type {const} */ (['active', 'archive', 'topics', 'topic-types'])) {
        const td = tab === 'topic-types' ? msg.data?.topicTypes : msg.data?.[tab];
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
      // The reveal highlight is re-applied inside render() via renderRow, so
      // it survives this data refresh automatically — no separate pass needed.
      return;
    }
    if (msg.type === 'reveal') {
      const target =
        msg.target && typeof msg.target === 'object' ? msg.target : null;
      state.revealTarget = target;
      // Pure re-render: renderRow adds `.revealed` to every matching row in the
      // active tab. No tab switch, no ancestor expand, no scroll.
      render();
      return;
    }
  });

  // Request initial data.
  vscode.postMessage({ type: 'ready' });
})();
