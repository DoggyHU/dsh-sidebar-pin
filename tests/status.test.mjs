/**
 * Unit lane for the pinned status mapping.
 *
 * The mapping is pure, so these cases pin the exact precedence the shipped
 * Session row applies: pending interaction > live activity (own turn or a
 * running direct subagent) > completion reminder > idle.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { runningChildCount, sessionPresentation } from '../src/client/status.js'

/** A status snapshot shaped like `uiSession.sessionStatus`. */
const statuses = (...entries) => new Map(entries)

/** A Session list snapshot carrying list rows and subagent catalogs. */
const sessions = (rows = {}, catalogs = {}) => ({
  byId: rows,
  projectionsBySession: Object.fromEntries(
    Object.entries(catalogs).map(([id, ids]) => [id, { values: { subagentCatalog: ids.map((child) => ({ id: child })) } }]),
  ),
})

test('a pending interaction becomes the warning dot, one label per kind', () => {
  const map = statuses(
    ['approval', { running: false, completionUnread: false, pendingInteraction: { kind: 'approval' } }],
    ['review', { running: false, completionUnread: false, pendingInteraction: { kind: 'plan-review' } }],
    ['question', { running: false, completionUnread: false, pendingInteraction: { kind: 'question' } }],
  )
  assert.deepEqual(sessionPresentation(map, sessions(), 'approval'), { dot: 'warning', label: '等待审批' })
  assert.deepEqual(sessionPresentation(map, sessions(), 'review'), { dot: 'warning', label: '等待计划审阅' })
  assert.deepEqual(sessionPresentation(map, sessions(), 'question'), { dot: 'warning', label: '等待回答' })
})

test('an unknown pending kind is not turned into a warning dot', () => {
  const map = statuses(['odd', { running: false, completionUnread: false, pendingInteraction: { kind: 'other' } }])
  assert.deepEqual(sessionPresentation(map, sessions(), 'odd'), { dot: null, label: '空闲' })
})

test('a live turn becomes the ongoing loader, from the status stream or the list row', () => {
  const fromStatus = statuses(['stream', { running: true, completionUnread: false }])
  assert.deepEqual(sessionPresentation(fromStatus, sessions(), 'stream'), { dot: 'ongoing', label: '运行中' })
  // A stream that has not established `running` falls back to the list row's own flag.
  const fromRow = statuses(['row', { running: undefined, completionUnread: false }])
  assert.deepEqual(sessionPresentation(fromRow, sessions({ row: { running: true } }), 'row'), { dot: 'ongoing', label: '运行中' })
})

test('a running direct subagent keeps the parent on the ongoing loader', () => {
  const map = statuses(
    ['parent', { running: false, completionUnread: false }],
    ['kid', { running: true, completionUnread: false }],
  )
  assert.deepEqual(
    sessionPresentation(map, sessions({ parent: { running: false } }, { parent: ['kid'] }), 'parent'),
    { dot: 'ongoing', label: '运行中' },
  )
  // The child's own list row is the fallback when the stream has no entry.
  assert.deepEqual(
    sessionPresentation(statuses(['parent', { running: false }]), sessions({ parent: {}, kid: { running: true } }, { parent: ['kid'] }), 'parent'),
    { dot: 'ongoing', label: '运行中' },
  )
})

test('a completion reminder becomes the green done dot only when nothing runs', () => {
  const map = statuses(['done', { running: false, completionUnread: true }])
  assert.deepEqual(sessionPresentation(map, sessions(), 'done'), { dot: 'done', label: '已完成' })
})

test('an idle session carries no marker at all', () => {
  const map = statuses(['idle', { running: false, completionUnread: false }])
  assert.deepEqual(sessionPresentation(map, sessions(), 'idle'), { dot: null, label: '空闲' })
})

test('precedence matches the shipped row', () => {
  const both = statuses(
    ['pending-and-running', { running: true, completionUnread: true, pendingInteraction: { kind: 'question' } }],
    ['running-and-done', { running: true, completionUnread: true }],
    ['done-and-subagent', { running: false, completionUnread: true }],
    ['kid', { running: true }],
  )
  const list = sessions({}, { 'done-and-subagent': ['kid'] })
  assert.equal(sessionPresentation(both, list, 'pending-and-running').dot, 'warning')
  assert.equal(sessionPresentation(both, list, 'running-and-done').dot, 'ongoing')
  assert.equal(sessionPresentation(both, list, 'done-and-subagent').dot, 'ongoing')
})

test('missing or malformed snapshots degrade to idle instead of throwing', () => {
  assert.deepEqual(sessionPresentation(undefined, undefined, 'ghost'), { dot: null, label: '空闲' })
  assert.deepEqual(sessionPresentation(null, null, 'ghost'), { dot: null, label: '空闲' })
  assert.deepEqual(sessionPresentation({ get: () => undefined }, sessions({ ghost: {} }), 'ghost'), { dot: null, label: '空闲' })
  assert.equal(runningChildCount(undefined, undefined, 'ghost'), 0)
  assert.equal(runningChildCount(statuses(), { byId: {}, projectionsBySession: { ghost: { values: {} } } }, 'ghost'), 0)
})
