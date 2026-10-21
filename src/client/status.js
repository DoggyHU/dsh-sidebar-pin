/**
 * Session status derivation for the pinned rows.
 *
 * The pinned section must never invent a state the shipped row below it does
 * not have, so this mirrors the shell's own precedence exactly, as the shipped
 * `sessionStatuses` applies it:
 *
 *   pending interaction  →  warning dot (approval / plan review / question)
 *   live activity        →  ongoing loader (own turn, or a running direct subagent)
 *   completion reminder  →  done dot (`completionUnread`)
 *   otherwise            →  no marker at all (the shipped row keeps the cell
 *                            for its leading seat and draws nothing)
 *
 * In particular the shell has no error state on a Session row: a failed turn
 * is not published in `SessionStatus`, so the pinned rows do not fake one.
 * Pure functions — no React, no DOM — so the mapping can be tested on its own.
 *
 * @module dsh-sidebar-pin/client/status
 */

/** The shipped row turns these pending interactions into its warning dot. */
export const PENDING_LABELS = { approval: '等待审批', 'plan-review': '等待计划审阅', question: '等待回答' }

/** What an idle row says when the operator hovers its marker cell. */
export const IDLE_LABEL = '空闲'

/**
 * Direct children still running, the count the shipped row folds into its own
 * `running` flag. The status stream is the primary evidence and the list row is
 * the fallback, exactly like the shell's `runningChildCount`.
 * @param {unknown} statuses - the `uiSession.sessionStatus` snapshot.
 * @param {unknown} sessions - the Session list snapshot.
 * @param {string} parentId - the parent Session's identity.
 * @returns {number} running direct children.
 */
export function runningChildCount(statuses, sessions, parentId) {
  const catalog = sessions?.projectionsBySession?.[parentId]?.values?.subagentCatalog
  if (!Array.isArray(catalog)) return 0
  let count = 0
  for (const child of catalog) {
    const childId = child?.id
    if (typeof childId !== 'string' || childId.length === 0) continue
    const childStatus = typeof statuses?.get === 'function' ? statuses.get(childId) : undefined
    const running = childStatus?.running ?? sessions?.byId?.[childId]?.running
    if (running === true) count += 1
  }
  return count
}

/**
 * One Session's presentation state, derived exactly like the shipped row.
 * @param {unknown} statuses - the `uiSession.sessionStatus` snapshot.
 * @param {unknown} sessions - the Session list snapshot.
 * @param {string} id - the Session's identity.
 * @returns {{dot: 'warning'|'ongoing'|'done'|null, label: string}}
 */
export function sessionPresentation(statuses, sessions, id) {
  const status = typeof statuses?.get === 'function' ? statuses.get(id) : undefined
  const row = sessions?.byId?.[id]
  const pending = status?.pendingInteraction?.kind
  if (typeof pending === 'string' && PENDING_LABELS[pending] !== undefined) {
    return { dot: 'warning', label: PENDING_LABELS[pending] }
  }
  const running = (status?.running ?? row?.running) === true
  if (running || runningChildCount(statuses, sessions, id) > 0) return { dot: 'ongoing', label: '运行中' }
  if (status?.completionUnread === true) return { dot: 'done', label: '已完成' }
  return { dot: null, label: IDLE_LABEL }
}
