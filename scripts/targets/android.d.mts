/**
 * Types for the Android deployment target.
 *
 * Only the exports the regression tests use are declared here; the module is
 * plain JavaScript so it can run without a build step.
 */

import type { Adb } from "../lib/deploy-lib.d.mts";

/**
 * Which folder `community-plugins.json` points at for `pluginId`, matched by the
 * manifest's declared `id` rather than by folder name.
 */
export interface ActiveFolderResult {
  list: string[] | null;
  folder: string | null;
  claimed: string[];
  pluginsRoot?: string;
}

export interface FakeAdb {
  readFile(path: string): string | null;
  isDirectory(path: string): boolean;
}

export declare function readLocalManifest(root: string): { id?: string; version?: string } | null;

/**
 * Leftover rotation folders to retire: our `<pluginId>-deploy-*` naming only,
 * excluding the install target, folders already scheduled, and anything that is
 * not a directory.
 */
export declare function selectStaleDeployFolders(
  entries: string[],
  pluginId: string,
  keep: string,
  retire: string[],
  isDirectory: (name: string) => boolean,
): string[];

/** Internals exposed for regression tests; not part of the deploy contract. */
export declare const __internal: {
  activeFolderFromRegistry(
    adb: Adb | FakeAdb,
    registryPath: string,
    pluginId: string,
  ): ActiveFolderResult;
  updateRegistry: unknown;
  migratePluginData: unknown;
};
