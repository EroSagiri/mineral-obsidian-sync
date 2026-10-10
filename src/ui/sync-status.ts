import { setIcon } from "obsidian";
import type { FailureClass, ResultCounts, SchedulerState } from "../scheduler/types";

/**
 * The status bar's whole job: one icon that says what Mineral Sync is doing.
 *
 * The mapping is a pure function so it can be pinned by tests, and the renderer only applies what the
 * mapping decided. Two rules shape it:
 *
 * - **One icon, never a different glyph per state.** The user should learn "this icon is Mineral Sync"
 *   once, and read the state from its colour, motion, and badge. The old status bar put a sentence
 *   there ("Mineral Sync ✓ idle"), which is debug text in a space meant for a glance.
 * - **Conflict outranks everything.** It is the only state that needs the user to act, so it wins even
 *   while a cycle is running or the transport is down.
 *
 * No new state machine is introduced: every input already exists in the scheduler's diagnostics.
 */

export type SyncStatusTone =
  /** Up to date; nothing pending. */
  | "idle"
  /** A change was seen and is waiting for its debounce — waiting, not broken. */
  | "waiting"
  /** A reconciliation is running. */
  | "syncing"
  /** At least one conflict needs a human decision. */
  | "conflict"
  /** The transport failed and will be retried (offline, 5xx, 429, an ambiguous PUT). */
  | "offline"
  /** A definitive failure: rejected credentials, or a write the Vault refused. */
  | "error";

/** The single glyph for every state. Never switched per state. */
export const SYNC_STATUS_ICON = "refresh-cw";

export interface SyncStatusInput {
  state: SchedulerState;
  counts: ResultCounts;
  lastFailureClass?: FailureClass;
  /** Unresolved conflicts the resolver can actually show. */
  conflictCount: number;
}

export interface SyncStatusPresentation {
  tone: SyncStatusTone;
  icon: string;
  spinning: boolean;
  /** Rendered in the corner; conflict count, or `!` for a definitive error. */
  badge?: string;
  /** `aria-label`, which is what Obsidian turns into a tooltip. */
  tooltip: string;
  /** What a click should do. A conflict click goes straight to the resolver, never via a menu. */
  action: "resolve-conflicts" | "sync-now";
}

const plural = (count: number): string => (count === 1 ? "" : "s");

/**
 * Priority, highest first: conflict, then offline/error, then syncing, then waiting, then idle.
 *
 * Within the failure tier a rejected credential is checked first because it stops every transfer,
 * whereas a retryable failure is expected to clear itself.
 */
export function presentSyncStatus(input: SyncStatusInput): SyncStatusPresentation {
  const conflicts = Math.max(0, input.conflictCount);
  if (conflicts > 0) {
    return {
      tone: "conflict", icon: SYNC_STATUS_ICON, spinning: false, badge: String(conflicts),
      tooltip: `Mineral Sync\n${conflicts} conflict${plural(conflicts)} need attention\nClick to resolve`,
      action: "resolve-conflicts",
    };
  }
  if (input.state === "blocked-by-auth") {
    return {
      tone: "error", icon: SYNC_STATUS_ICON, spinning: false, badge: "!",
      tooltip: "Mineral Sync\nSync error\nR2 rejected the stored credentials\nCheck the plugin settings",
      action: "sync-now",
    };
  }
  if ((input.counts.unresolved ?? 0) > 0 || input.lastFailureClass === "retryable") {
    return {
      tone: "offline", icon: SYNC_STATUS_ICON, spinning: false,
      tooltip: "Mineral Sync\nOffline\nChanges will sync when the connection resumes",
      action: "sync-now",
    };
  }
  if (input.lastFailureClass === "stable" || (input.counts.failed ?? 0) > 0) {
    return {
      tone: "error", icon: SYNC_STATUS_ICON, spinning: false, badge: "!",
      tooltip: "Mineral Sync\nSync error\nSome files could not be synced\nClick to retry",
      action: "sync-now",
    };
  }
  if (input.state === "running") {
    return { tone: "syncing", icon: SYNC_STATUS_ICON, spinning: true, tooltip: "Mineral Sync\nSyncing…", action: "sync-now" };
  }
  if (input.state === "debouncing" || input.state === "rerun-pending") {
    return { tone: "waiting", icon: SYNC_STATUS_ICON, spinning: false, tooltip: "Mineral Sync\nWaiting for changes to settle…", action: "sync-now" };
  }
  return { tone: "idle", icon: SYNC_STATUS_ICON, spinning: false, tooltip: "Mineral Sync\nUp to date", action: "sync-now" };
}

/**
 * Applies a presentation to the status bar item.
 *
 * Only the inner content is rebuilt, so a click handler can stay attached to the item itself across
 * updates. The tooltip is `aria-label`, which is the attribute Obsidian's own tooltip layer reads.
 */
export function renderSyncStatus(host: HTMLElement, presentation: SyncStatusPresentation): void {
  host.empty();
  host.addClass("mineral-sync-status-host");
  const root = host.createSpan({ cls: `mineral-sync-status mineral-sync-status--${presentation.tone}${presentation.spinning ? " is-spinning" : ""}` });
  const icon = root.createSpan({ cls: "mineral-sync-status__icon" });
  setIcon(icon, presentation.icon);
  if (presentation.badge !== undefined) root.createSpan({ cls: "mineral-sync-status__badge", text: presentation.badge });
  root.setAttribute("aria-label", presentation.tooltip);
  root.setAttribute("data-tooltip-position", "top");
}

/**
 * Theme-variable only, so light and dark both work without a second definition: no colour is written
 * by hand, and each one degrades to another Obsidian variable when a theme omits it.
 */
export const SYNC_STATUS_CSS = `
.mineral-sync-status-host { display: flex; align-items: center; }
.mineral-sync-status { display: inline-flex; align-items: center; gap: 2px; cursor: pointer; padding: 0 2px; }
.mineral-sync-status__icon { display: inline-flex; }
.mineral-sync-status__icon svg { width: 15px; height: 15px; }
.mineral-sync-status--idle .mineral-sync-status__icon { color: var(--text-muted); opacity: 0.7; }
.mineral-sync-status--waiting .mineral-sync-status__icon { color: var(--text-faint, var(--text-muted)); opacity: 0.45; }
.mineral-sync-status--syncing .mineral-sync-status__icon { color: var(--interactive-accent); }
.mineral-sync-status--conflict .mineral-sync-status__icon { color: var(--color-yellow, var(--text-warning)); }
.mineral-sync-status--offline .mineral-sync-status__icon,
.mineral-sync-status--error .mineral-sync-status__icon { color: var(--color-red, var(--text-error)); }
.mineral-sync-status.is-spinning .mineral-sync-status__icon { animation: mineral-sync-spin 1.1s linear infinite; }
.mineral-sync-status__badge { font-size: 9px; line-height: 1; font-weight: 600; padding: 1px 3px; border-radius: var(--radius-s, 4px); background: var(--background-modifier-border); color: var(--text-normal); }
.mineral-sync-status--conflict .mineral-sync-status__badge { background: var(--color-yellow, var(--text-warning)); color: var(--background-primary); }
.mineral-sync-status--error .mineral-sync-status__badge { background: var(--color-red, var(--text-error)); color: var(--background-primary); }
@keyframes mineral-sync-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mineral-sync-status.is-spinning .mineral-sync-status__icon { animation: none; } }
`;
