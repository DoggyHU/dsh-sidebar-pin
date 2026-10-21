/**
 * Host half of dsh-sidebar-pin.
 *
 * The pinned list is a pure client-side projection: pins live in the browser's
 * `localStorage` and every action goes through official client services
 * (`uiWorkspace.openSession`, the workspace registry snapshot). The host half
 * therefore only needs to exist so the bundle has a row to mount — it registers
 * nothing and keeps no state.
 *
 * @module dsh-sidebar-pin
 */

/** Cordis plugin name. */
export const name = 'dsh-sidebar-pin'

/** No host services are required. */
export const inject = []

/** Mount the (empty) host half. */
export function apply() {}
