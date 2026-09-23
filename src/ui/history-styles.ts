/**
 * History viewer styling, in theme variables only.
 *
 * Two details are load-bearing rather than decorative: a row is a two-column grid so the clock time
 * stays aligned down the list while a long path wraps instead of pushing the `View` button around, and
 * every surface uses an Obsidian variable so light, dark and community themes all render without a
 * second definition.
 */
export const SYNC_HISTORY_CSS = `
.mineral-sync-history__notice { margin: 4px 0 8px; color: var(--text-muted); }
.mineral-sync-history__empty { color: var(--text-muted); }
.mineral-sync-history__day { margin: 14px 0 4px; color: var(--text-muted); font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.04em; }
.mineral-sync-history__row { display: grid; grid-template-columns: 5ch 1fr auto; align-items: start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--background-modifier-border); }
.mineral-sync-history__time { color: var(--text-muted); font-family: var(--font-monospace); font-size: var(--font-ui-smaller); }
.mineral-sync-history__path { margin: 0; font-weight: 600; }
.mineral-sync-history__description { margin: 0; }
.mineral-sync-history__evidence { margin: 0; color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-history__section-title { margin: 12px 0 4px; color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-history__time-full { margin: 0 0 4px; color: var(--text-muted); }
.mineral-sync-history__preview { margin: 0; padding: 8px; max-height: 320px; overflow: auto; white-space: pre-wrap; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s, 4px); }
.mineral-sync-history__before-side { margin: 6px 0; padding: 6px 8px; background: var(--background-secondary); border-left: 3px solid var(--background-modifier-border); }
.mineral-sync-history__before-label { margin: 0 0 2px; font-weight: 600; }
.mineral-sync-history__before-facts { margin: 0 0 6px; color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-history__confirm { margin: 8px 0; }
.mineral-sync-history__confirm p { margin: 4px 0; }
.mineral-sync-history__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.mineral-sync-history__technical { margin-top: 14px; color: var(--text-muted); }
.mineral-sync-history__technical summary { cursor: pointer; }
.mineral-sync-history__technical-row pre { margin: 2px 0 8px; padding: 6px; max-height: 160px; overflow: auto; white-space: pre-wrap; color: var(--text-normal); background: var(--background-secondary); }
`;
