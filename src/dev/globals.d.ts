/**
 * Compile-time development flag.
 *
 * `esbuild.config.mjs` defines this identifier as `true` for `npm run dev` and as
 * `false` for `npm run build` (production). Every `if (__DEV__)` block is therefore
 * folded away in the shipped bundle, so production never registers a development-only
 * command or ships a diagnostic entry point.
 */
declare const __DEV__: boolean;
