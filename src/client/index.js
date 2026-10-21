/**
 * Client half of dsh-sidebar-pin.
 *
 * Two sources feed the pinned section:
 *
 *  - Sessions come from the Host registry-global pin set, which the official
 *    Workspace snapshot publishes as `pinnedSessionIds`. The plugin only calls
 *    the official `pinSession` / `unpinSession`, so a Session pinned from the
 *    shipped row menu shows up here too and the state never forks.
 *  - Workspaces have no native pin in DSH 0.2.1 (the registry keeps display
 *    order only), so they live in this plugin's own browser storage.
 *
 * Every pinned Session row carries the shipped row's status marker: the same
 * `StateDot` the shell draws, fed by `uiSession.sessionStatus` and split with
 * the shell's own precedence (pending interaction, then live activity —
 * including running subagents — then the completion reminder). The pinned
 * section therefore never invents a state the row below it does not have.
 *
 * The section rides a DOM portal above the browsing region's section header:
 * the sidebar declares `sidebar.workspaces` as a single-occupant slot and no
 * hole beside its header, so the region's own position in the sidebar column is
 * the only place a new block can live.
 *
 * @module dsh-sidebar-pin/client
 */

import { sessionPresentation } from './status.js'

const React = require('react')
const { createPortal } = require('react-dom')
const { StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

/** localStorage key holding the pinned Workspaces and the fold state. */
const STORE_KEY = 'dsh.sidebar-pin.v1'

/** Prefix the official workspace rows use in `data-row-key`. */
const WORKSPACE_ROW_PREFIX = 'workspace:'

/** Services this client half needs before it mounts. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace']

/* ------------------------------------------------------------------ store -- */

/** @param {unknown} entry */
function valid(entry) {
  return entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0
}

/** @returns {{workspaces: Array<{id: string, title: string, at: number}>, collapsed: boolean, expanded: Record<string, boolean>}} */
function readState() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw === null) return { workspaces: [], collapsed: false, expanded: {} }
    const parsed = JSON.parse(raw)
    const expanded = {}
    if (parsed?.expanded !== null && typeof parsed?.expanded === 'object') {
      for (const [key, value] of Object.entries(parsed.expanded)) {
        if (value === true || value === false) expanded[key] = value
      }
    }
    return {
      workspaces: Array.isArray(parsed?.workspaces) ? parsed.workspaces.filter(valid) : [],
      collapsed: parsed?.collapsed === true,
      expanded,
    }
  } catch {
    return { workspaces: [], collapsed: false, expanded: {} }
  }
}

/** Minimal external store: one snapshot object, one listener set. */
function createStore() {
  let state = readState()
  const listeners = new Set()
  const emit = () => { for (const listener of listeners) listener() }
  const commit = (next) => {
    state = next
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch { /* quota / private mode */ }
    emit()
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot() { return state },
    isWorkspacePinned(id) { return state.workspaces.some((entry) => entry.id === id) },
    /** A pinned Workspace shows its Sessions unless it was folded by hand. */
    isExpanded(id) { return state.expanded[id] !== false },
    toggleExpanded(id) { commit({ ...state, expanded: { ...state.expanded, [id]: !this.isExpanded(id) } }) },
    toggleWorkspace(id, title) {
      const next = state.workspaces.some((entry) => entry.id === id)
        ? state.workspaces.filter((entry) => entry.id !== id)
        : [...state.workspaces, { id, title: typeof title === 'string' ? title : '', at: Date.now() }]
      commit({ ...state, workspaces: next })
    },
    unpinWorkspace(id) {
      commit({ ...state, workspaces: state.workspaces.filter((entry) => entry.id !== id) })
    },
    setCollapsed(collapsed) { commit({ ...state, collapsed }) },
    renameWorkspace(id, title) {
      if (typeof title !== 'string' || title.length === 0) return
      if (!state.workspaces.some((entry) => entry.id === id && entry.title !== title)) return
      commit({ ...state, workspaces: state.workspaces.map((entry) => (entry.id === id ? { ...entry, title } : entry)) })
    },
  }
}

/* -------------------------------------------------------------- snapshots -- */

/** Subscribe to one official snapshot source (`{subscribe, getSnapshot}`). */
function useSnapshot(source) {
  const subscribe = useCallback((listener) => {
    if (source === undefined || source === null || typeof source.subscribe !== 'function') return () => {}
    return source.subscribe(listener)
  }, [source])
  const read = useCallback(() => {
    try { return source?.getSnapshot?.() } catch { return undefined }
  }, [source])
  return useSyncExternalStore(subscribe, read, read)
}

/** The pinned Workspace state, as a React value. */
function useStore(store) {
  const subscribe = useCallback((listener) => store.subscribe(listener), [store])
  const read = useCallback(() => store.getSnapshot(), [store])
  return useSyncExternalStore(subscribe, read, read)
}

/** The Workspace registry snapshot's `items` list, defensively. */
function workspaceArray(snapshot) {
  const items = snapshot?.items
  return Array.isArray(items) ? items : []
}

/** The Host registry-global pinned Session ids. */
function pinnedSessionIds(snapshot) {
  const ids = snapshot?.pinnedSessionIds
  return Array.isArray(ids) ? ids : []
}

/** @param {unknown} snapshot @param {string} id */
function sessionTitle(snapshot, id) {
  const row = snapshot?.byId?.[id]
  const title = row?.title ?? row?.displayTitle ?? row?.name
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

/** One `WorkspaceView`'s identity (`workspaceId`; `id` is only a fallback). */
function workspaceIdOf(item) {
  const id = item?.workspaceId ?? item?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** @param {unknown} snapshot @param {string} id */
function workspaceTitle(snapshot, id) {
  const item = workspaceArray(snapshot).find((entry) => workspaceIdOf(entry) === id)
  const title = item?.title ?? item?.name
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

/**
 * A Workspace's own Sessions, newest first: archived rows and subagent rows are
 * skipped the way the shipped sidebar skips them.
 * @param {unknown} sessions - `SessionListState`.
 * @param {unknown} workspaces - `WorkspaceSnapshot`.
 * @param {string} id - the Workspace's identity.
 * @returns {Array<{id: string, title: string, at: string}>}
 */
function workspaceSessions(sessions, workspaces, id) {
  const item = workspaceArray(workspaces).find((entry) => workspaceIdOf(entry) === id)
  const ids = Array.isArray(item?.sessionIds) ? item.sessionIds : []
  const archived = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : [])
  const rows = []
  for (const sessionId of ids) {
    if (archived.has(sessionId)) continue
    const row = sessions?.byId?.[sessionId]
    if (row?.origin === 'subagent' || row?.parentSession !== undefined || row?.parentId !== undefined) continue
    rows.push({
      id: sessionId,
      title: sessionTitle(sessions, sessionId) ?? sessionId,
      at: String(row?.updatedAt ?? row?.lastActivityAt ?? row?.createdAt ?? ''),
    })
  }
  rows.sort((left, right) => right.at.localeCompare(left.at))
  return rows
}

/* ------------------------------------------------------------------- dom --- */

const HOST_CLASS = 'sp-host'

/** The sidebar's browsing region, or its section header's wrapping element. */
function findRegion() {
  const bySlot = document.querySelector('[data-slot="sidebar.workspaces"]')
  if (bySlot !== null && bySlot.parentElement !== null) return bySlot
  const header = document.querySelector('[class*="sectionHeader"]')
  if (header !== null && header.parentElement !== null && header.parentElement.parentElement !== null) {
    return header.parentElement
  }
  return null
}

/** Keep one portal container directly above the browsing region. */
function ensureHost() {
  const region = findRegion()
  if (region === null || region.parentElement === null) return null
  const parent = region.parentElement
  const existing = parent.querySelector(`:scope > .${HOST_CLASS}`)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.className = HOST_CLASS
  parent.insertBefore(host, region)
  return host
}

/** Create (and keep attached) the portal container. */
function useHost() {
  const [host, setHost] = useState(null)
  useEffect(() => {
    let current = null
    const attach = () => {
      const next = ensureHost()
      if (next !== current) { current = next; setHost(next) }
    }
    attach()
    const observer = new MutationObserver(() => { attach() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (current !== null && current.isConnected) current.remove()
    }
  }, [])
  return host
}

/** Reveal a native row without opening anything. */
function revealRow(rowKey) {
  const row = document.querySelector(`[data-row-key="${rowKey}"]`)
  if (row === null) return
  row.scrollIntoView({ block: 'nearest' })
}

/* ------------------------------------------------- workspace row menu ------ */

const MENU_SELECTOR = '[role="menu"]'
const MENU_ITEM_SELECTOR = '[role="menuitem"]'
const DECORATED = 'spDecorated'

/**
 * Add a pin entry to the shipped **Workspace** row menu.
 *
 * The shell declares row-menu slots for Sessions only, so a Workspace row's
 * "..." menu is decorated in the DOM: the last workspace row the operator
 * pressed identifies the menu's subject, and the entry clones the shipped
 * items' classes so it inherits their styling.
 *
 * @param {object} store - the pinned-Workspace store.
 * @param {() => unknown} readSnapshot - reads the current Workspace snapshot.
 * @returns {() => void} teardown.
 */
function installWorkspaceMenu(store, readSnapshot) {
  let subject = null

  const remember = (event) => {
    const target = event.target
    if (target === null || typeof target.closest !== 'function') return
    const row = target.closest(`[data-row-key^="${WORKSPACE_ROW_PREFIX}"]`)
    if (row === null) return
    const key = row.getAttribute('data-row-key') ?? ''
    const id = key.slice(WORKSPACE_ROW_PREFIX.length)
    if (id.length > 0) subject = id
  }

  const decorate = (menu) => {
    if (!(menu instanceof HTMLElement)) return
    if (menu.dataset[DECORATED] === '1') return
    const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR))
    if (items.length === 0) return
    const labels = items.map((item) => item.textContent ?? '')
    const isWorkspaceMenu = labels.some((label) => label.includes('重命名'))
      && labels.some((label) => label.includes('工作区'))
    if (!isWorkspaceMenu || subject === null) return
    menu.dataset[DECORATED] = '1'
    const id = subject
    const sample = items[items.length - 1]
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.tabIndex = -1
    if (typeof sample?.className === 'string') button.className = sample.className
    button.classList.add('sp-menuInjected')
    const pinned = store.isWorkspacePinned(id)
    const icon = document.createElement('span')
    icon.className = 'sp-menuIcon'
    icon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.6 1.4a.75.75 0 0 1 .82.16l4 4a.75.75 0 0 1-.53 1.28h-2.3L8.9 9.53v3.22a.75.75 0 0 1-1.28.53l-2.6-2.6-2.72 2.72a.75.75 0 0 1-1.06-1.06L3.96 9.6l-2.6-2.6A.75.75 0 0 1 1.9 5.72h3.22L7.8 3.02V.72a.75.75 0 0 1 .8-.68Z"/></svg>'
    const label = document.createElement('span')
    label.textContent = pinned ? '取消置顶工作区' : '置顶工作区'
    button.append(icon, label)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const title = workspaceTitle(readSnapshot(), id) ?? id
      store.toggleWorkspace(id, title)
      dismissMenu(menu)
    })
    menu.append(button)
  }

  const scan = (root) => {
    if (root instanceof HTMLElement && root.matches(MENU_SELECTOR)) decorate(root)
    if (root instanceof HTMLElement) {
      for (const menu of root.querySelectorAll(MENU_SELECTOR)) decorate(menu)
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node)
    }
    // The shipped menu can also gain its items after the popup mounts.
    for (const menu of document.querySelectorAll(MENU_SELECTOR)) decorate(menu)
  })

  document.addEventListener('pointerdown', remember, true)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    document.removeEventListener('pointerdown', remember, true)
    observer.disconnect()
  }
}

/** Close a shipped popup menu the way Escape does. */
function dismissMenu(menu) {
  for (const target of [menu, document]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
}

/* --------------------------------------------------------------- section --- */

const FolderIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  h('path', {
    fill: 'currentColor',
    d: 'M1.5 3.25c0-.41.34-.75.75-.75h3.2c.2 0 .39.08.53.22l.9.9h6.87c.41 0 .75.34.75.75v8.38c0 .41-.34.75-.75.75H2.25a.75.75 0 0 1-.75-.75V3.25Z',
  }))

const ChatIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  h('path', {
    fill: 'currentColor',
    d: 'M2.5 3.25c0-.69.56-1.25 1.25-1.25h8.5c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H6.9L4 13v-2.5H3.75c-.69 0-1.25-.56-1.25-1.25v-6Z',
  }))

const CloseIcon = () => h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true' },
  h('path', {
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', d: 'M4 4l8 8M12 4l-8 8',
  }))

const PlusIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  h('path', {
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', d: 'M8 3.5v9M3.5 8h9',
  }))

const ChevronIcon = ({ collapsed }) => h('svg', {
  viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true',
  style: { transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms ease' },
}, h('path', {
  fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round',
  'stroke-linejoin': 'round', d: 'M4 6.5L8 10.5l4-4',
}))

/**
 * One pinned row: status marker (or the row's own icon while idle), title, and
 * a hover unpin button. The marker is the shipped `StateDot`, so a pinned row
 * and the shipped row below it spin and dot in the same phases.
 * @param {{kind: 'workspaces'|'sessions', id: string, title: string, nested?: boolean, status?: {dot: string|null, label: string}, onOpen: Function, onUnpin?: Function}} props
 */
function PinnedRow({ kind, id, title, nested, status, onOpen, onUnpin }) {
  const dot = status?.dot ?? null
  const label = status?.label ?? ''
  return h('div', {
    className: nested === true ? 'sp-row sp-rowNested' : 'sp-row',
    role: 'button',
    tabIndex: 0,
    title: dot === null ? title : `${title} · ${label}`,
    'data-session-id': kind === 'sessions' ? id : undefined,
    onClick: () => onOpen(id),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(id) }
    },
  },
  dot === null
    ? h('span', { className: 'sp-rowIcon' }, kind === 'workspaces' ? h(FolderIcon) : h(ChatIcon))
    : h('span', { className: 'sp-rowIcon sp-stateDot', role: 'img', title: label, 'aria-label': label, 'data-state': dot },
      h(StateDot, { state: dot })),
  h('span', { className: 'sp-rowTitle' }, title),
  typeof onUnpin === 'function'
    ? h('button', {
      type: 'button',
      className: 'sp-unpin',
      'aria-label': '取消置顶',
      title: '取消置顶',
      onClick: (event) => { event.stopPropagation(); onUnpin(id) },
    }, h(CloseIcon))
    : null)
}

/**
 * One pinned Workspace: a fold toggle, the name, its Session count, unpin.
 * @param {{title: string, count: number, expanded: boolean, onToggle: Function, onOpen: Function, onUnpin: Function}} props
 */
function PinnedWorkspaceRow({ title, count, expanded, onToggle, onOpen, onUnpin }) {
  return h('div', { className: 'sp-row sp-wsRow' },
    h('button', {
      type: 'button',
      className: 'sp-chev',
      'aria-expanded': expanded,
      'aria-label': expanded ? '折叠该工作区' : '展开该工作区',
      title: expanded ? '折叠' : '展开',
      onClick: (event) => { event.stopPropagation(); onToggle() },
    }, h(ChevronIcon, { collapsed: !expanded })),
    h('span', { className: 'sp-rowIcon' }, h(FolderIcon)),
    h('button', {
      type: 'button',
      className: 'sp-rowTitle sp-wsName',
      title,
      onClick: () => onOpen(),
    }, title),
    count > 0 ? h('span', { className: 'sp-count' }, String(count)) : null,
    h('button', {
      type: 'button',
      className: 'sp-unpin',
      'aria-label': '取消置顶',
      title: '取消置顶',
      onClick: (event) => { event.stopPropagation(); onUnpin() },
    }, h(CloseIcon)))
}

/**
 * The pinned section: a header row plus the pinned Workspaces and Sessions.
 * @param {{store: object, sessions: object, workspaces: object, statuses: object, uiWorkspace: object}} props
 */
function PinnedSection({ store, sessions, workspaces, statuses, uiWorkspace }) {
  const state = useStore(store)
  const sessionSnapshot = useSnapshot(sessions)
  const workspaceSnapshot = useSnapshot(workspaces)
  const statusSnapshot = useSnapshot(statuses)
  const [pickerOpen, setPickerOpen] = useState(false)
  const wrapRef = useRef(null)

  // Keep the stored Workspace titles aligned with the registry.
  useEffect(() => {
    for (const entry of state.workspaces) {
      const live = workspaceTitle(workspaceSnapshot, entry.id)
      if (live !== undefined) store.renameWorkspace(entry.id, live)
    }
  }, [workspaceSnapshot, state.workspaces, store])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const close = (event) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setPickerOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') setPickerOpen(false) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  const openSession = useCallback((id) => {
    try { uiWorkspace?.openSession?.(id) } catch { /* the shell refused */ }
  }, [uiWorkspace])

  const unpinSession = useCallback((id) => {
    try { uiWorkspace?.unpinSession?.(id) } catch { /* the shell refused */ }
  }, [uiWorkspace])

  const sessionIds = pinnedSessionIds(workspaceSnapshot)
  const allWorkspaces = useMemo(() => workspaceArray(workspaceSnapshot), [workspaceSnapshot])
  const topLevelPinned = useMemo(() => new Set(sessionIds), [sessionIds])
  const total = sessionIds.length + state.workspaces.length

  const workspaceGroups = state.workspaces.map((entry) => {
    const expanded = store.isExpanded(entry.id)
    const title = workspaceTitle(workspaceSnapshot, entry.id) ?? (entry.title.length > 0 ? entry.title : entry.id)
    const children = workspaceSessions(sessionSnapshot, workspaceSnapshot, entry.id)
    return h(React.Fragment, { key: `w:${entry.id}` },
      h(PinnedWorkspaceRow, {
        title,
        count: children.length,
        expanded,
        onToggle: () => store.toggleExpanded(entry.id),
        onOpen: () => revealRow(`${WORKSPACE_ROW_PREFIX}${entry.id}`),
        onUnpin: () => store.unpinWorkspace(entry.id),
      }),
      expanded
        ? children.map((child) => h(PinnedRow, {
          key: `ws:${entry.id}:${child.id}`,
          kind: 'sessions',
          id: child.id,
          title: child.title,
          nested: true,
          status: sessionPresentation(statusSnapshot, sessionSnapshot, child.id),
          onOpen: openSession,
          onUnpin: topLevelPinned.has(child.id) ? unpinSession : undefined,
        }))
        : null)
  })

  const sessionRows = sessionIds.map((id) => h(PinnedRow, {
    key: `s:${id}`,
    kind: 'sessions',
    id,
    title: sessionTitle(sessionSnapshot, id) ?? id,
    status: sessionPresentation(statusSnapshot, sessionSnapshot, id),
    onOpen: openSession,
    onUnpin: unpinSession,
  }))

  return h('div', { className: 'sp-section', ref: wrapRef },
    h('div', { className: 'sp-header' },
      h('button', {
        type: 'button',
        className: 'sp-headerLabel',
        'aria-expanded': !state.collapsed,
        onClick: () => store.setCollapsed(!state.collapsed),
      }, h(ChevronIcon, { collapsed: state.collapsed }), h('span', null, '置顶'), total > 0 ? h('span', { className: 'sp-count' }, String(total)) : null),
      h('button', {
        type: 'button',
        className: 'sp-add',
        'aria-label': '置顶一个工作区',
        title: '置顶一个工作区',
        onClick: () => setPickerOpen((open) => !open),
      }, h(PlusIcon))),
    state.collapsed ? null : h('div', { className: 'sp-body' },
      total === 0
        ? h('div', { className: 'sp-empty' }, '工作区：行尾 ⋯ 菜单 → 置顶工作区（或点这里右上角 +）。会话：行尾 ⋯ 菜单 → 置顶到顶部。')
        : null,
      workspaceGroups,
      sessionRows),
    pickerOpen
      ? h('div', { className: 'sp-picker', role: 'menu' },
        allWorkspaces.length === 0
          ? h('div', { className: 'sp-pickerEmpty' }, '还没有工作区')
          : allWorkspaces.map((workspace) => {
            const id = workspaceIdOf(workspace) ?? String(workspace?.title ?? '')
            const title = workspaceTitle(workspaceSnapshot, id) ?? String(id)
            const pinned = state.workspaces.some((entry) => entry.id === id)
            return h('button', {
              key: String(id),
              type: 'button',
              role: 'menuitemcheckbox',
              'aria-checked': pinned,
              className: pinned ? 'sp-pickerItem sp-pickerItemOn' : 'sp-pickerItem',
              onClick: () => store.toggleWorkspace(id, title),
            }, h('span', { className: 'sp-pickerMark' }, pinned ? '✓' : ''), h('span', { className: 'sp-rowTitle' }, title))
          }))
      : null)
}

/** The portal mount: renders the section into the sidebar column. */
function SectionMount({ store, sessions, workspaces, statuses, uiWorkspace }) {
  const host = useHost()
  if (host === null) return null
  return createPortal(
    h(PinnedSection, { store, sessions, workspaces, statuses, uiWorkspace }),
    host,
    'sidebar-pin',
  )
}

/* ------------------------------------------------------------- row menu ---- */

/**
 * Session row menu entry: pin or unpin through the official pin action, so the
 * section and the shipped pin marker never disagree.
 * @param {{sessionId: string, useMenuOpenState: Function, workspaces: object, uiWorkspace: object}} props
 */
function PinSessionMenuItem({ sessionId, useMenuOpenState, workspaces, uiWorkspace }) {
  const snapshot = useSnapshot(workspaces)
  const pinned = pinnedSessionIds(snapshot).includes(sessionId)
  const close = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : undefined
  return h('button', {
    type: 'button',
    role: 'menuitem',
    className: 'sp-menuItem',
    onClick: () => {
      try {
        if (pinned) uiWorkspace?.unpinSession?.(sessionId)
        else uiWorkspace?.pinSession?.(sessionId)
      } catch { /* the shell refused */ }
      if (typeof close === 'function') close(false)
    },
  }, pinned ? '取消置顶到顶部' : '置顶到顶部')
}

/* ------------------------------------------------------------------ css ---- */

const STYLE_ID = 'dsh-sidebar-pin-styles'

const CSS = `
.sp-host { display: block; }
.sp-section { padding: 2px 8px 6px; font-size: 13px; color: var(--dsw-alias-text-1, inherit); }
.sp-header { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 2px; }
.sp-headerLabel { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0;
  background: none; border: 0; padding: 0 2px; color: var(--dsw-alias-text-3, #8a8f98); cursor: pointer;
  font: inherit; font-size: 12px; letter-spacing: .02em; }
.sp-headerLabel:hover { color: var(--dsw-alias-text-1, inherit); }
.sp-count { color: var(--dsw-alias-text-3, #8a8f98); font-variant-numeric: tabular-nums; }
.sp-add, .sp-unpin { display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 0; border-radius: 6px; padding: 3px; cursor: pointer;
  color: var(--dsw-alias-text-3, #8a8f98); opacity: 0; transition: opacity 100ms ease, background 100ms ease; }
.sp-add { opacity: .75; }
.sp-header:hover .sp-add, .sp-add:focus-visible { opacity: 1; }
.sp-row:hover .sp-unpin, .sp-unpin:focus-visible { opacity: 1; }
.sp-add:hover, .sp-unpin:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: var(--dsw-alias-text-1, inherit); }
.sp-body { display: flex; flex-direction: column; gap: 1px; }
.sp-row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 6px 0 4px;
  border-radius: 7px; cursor: pointer; min-width: 0; }
.sp-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.sp-rowIcon { display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; color: var(--dsw-alias-text-3, #8a8f98); flex: 0 0 16px; }
.sp-stateDot { color: inherit; }
.sp-rowNested { padding-left: 24px; height: 26px; }
.sp-rowNested .sp-rowIcon { opacity: .8; }
.sp-wsRow { padding-left: 0; }
.sp-chev { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: 18px; height: 18px; margin-right: 2px; padding: 0; background: none; border: 0; cursor: pointer;
  color: var(--dsw-alias-text-3, #8a8f98); border-radius: 5px; }
.sp-chev:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16)); color: var(--dsw-alias-text-1, inherit); }
.sp-wsName { background: none; border: 0; padding: 0; margin: 0; text-align: left; font: inherit;
  color: inherit; cursor: pointer; }
.sp-rowTitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-empty { padding: 2px 6px 4px; color: var(--dsw-alias-text-3, #8a8f98); font-size: 12px; line-height: 1.5; }
.sp-picker { margin: 4px 0 2px; padding: 4px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.10));
  border: 1px solid var(--dsw-alias-border-1, rgba(127,127,127,.22)); max-height: 260px; overflow: auto; }
.sp-pickerItem { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; padding: 0 6px;
  background: none; border: 0; border-radius: 6px; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sp-pickerItem:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
.sp-pickerItemOn { color: var(--dsw-alias-text-1, inherit); }
.sp-pickerMark { width: 12px; flex: 0 0 auto; color: var(--dsw-accent, #4f8cff); }
.sp-pickerEmpty { padding: 6px; color: var(--dsw-alias-text-3, #8a8f98); font-size: 12px; }
.sp-menuItem { width: 100%; }
.sp-menuInjected { width: 100%; }
.sp-menuIcon { display: inline-flex; flex: 0 0 auto; }
`

function injectStyles() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-sidebar-pin'
  style.textContent = CSS
  document.head.append(style)
}

/* ------------------------------------------------------------------ apply -- */

/** Mount the browser half. */
export function apply(ctx) {
  const store = createStore()
  const sessions = ctx.get('sessions')?.list
  const workspaces = ctx.get('workspaces')?.list
  const statuses = ctx.get('uiSession')?.sessionStatus
  const uiWorkspace = ctx.get('uiWorkspace')
  const readSnapshot = () => {
    try { return workspaces?.getSnapshot?.() } catch { return undefined }
  }

  ctx.effect(() => {
    injectStyles()
    return () => { document.getElementById(STYLE_ID)?.remove() }
  }, 'sidebar-pin: styles')

  ctx.effect(() => installWorkspaceMenu(store, readSnapshot), 'sidebar-pin: workspace menu')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'sidebar-pin.section',
    order: 10,
    inject: () => ({ store, sessions, workspaces, statuses, uiWorkspace }),
  }, SectionMount)), 'sidebar-pin: section')

  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'sidebar-pin.toggle',
    order: 150,
    inject: () => ({ workspaces, uiWorkspace }),
  }, PinSessionMenuItem)), 'sidebar-pin: session menu entry')
}
