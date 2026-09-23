/**
 * Resolver styling, in theme variables only.
 *
 * Two details are load-bearing rather than decorative: the difference columns are a grid, so the two
 * sides really are side by side, and every surface uses an Obsidian variable so a light theme, a dark
 * theme and a community theme all render without a second definition.
 */
export const CONFLICT_RESOLVER_CSS = `
.mineral-sync-conflicts__path { margin: 0; }
.mineral-sync-conflicts__headline { margin: 4px 0 8px; font-weight: 600; }
.mineral-sync-conflicts__notice { margin: 4px 0 8px; color: var(--text-muted); }
.mineral-sync-conflicts__count { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-conflicts__pager { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mineral-sync-conflicts__hunk { margin: 10px 0; }
.mineral-sync-conflicts__hunk-title { margin: 0 0 4px; color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-conflicts__context { margin: 0; padding: 4px 8px; white-space: pre-wrap; color: var(--text-faint); background: var(--background-secondary); font-size: var(--font-ui-smaller); }
.mineral-sync-conflicts__columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mineral-sync-conflicts__side-heading { margin: 0 0 2px; color: var(--text-muted); font-size: var(--font-ui-smaller); }
.mineral-sync-conflicts__side-body { margin: 0; padding: 8px; max-height: 220px; overflow: auto; white-space: pre-wrap; background: var(--background-secondary); border-left: 3px solid var(--background-modifier-border); }
.mineral-sync-conflicts__side--current .mineral-sync-conflicts__side-body { border-left-color: var(--interactive-accent); }
.mineral-sync-conflicts__side--other .mineral-sync-conflicts__side-body { border-left-color: var(--color-yellow, var(--text-warning)); }
.mineral-sync-conflicts__preview { margin: 8px 0; }
.mineral-sync-conflicts__result { margin: 0; padding: 8px; max-height: 320px; overflow: auto; white-space: pre-wrap; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s, 4px); }
.mineral-sync-conflicts__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.mineral-sync-conflicts__editor { width: 100%; font-family: var(--font-monospace); }
.mineral-sync-conflicts__technical { margin-top: 14px; color: var(--text-muted); }
.mineral-sync-conflicts__technical pre { margin: 2px 0 8px; padding: 6px; max-height: 160px; overflow: auto; white-space: pre-wrap; color: var(--text-normal); background: var(--background-secondary); }
`;
