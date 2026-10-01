/**
 * Types for the deployment plumbing module.
 *
 * `scripts/` is plain JavaScript so it can run without a build step, but the
 * regression tests in `test/deploy.test.ts` are TypeScript. This declaration file
 * lets `tsc --noEmit` type-check those tests; keep it in sync with the exports in
 * `deploy-lib.mjs`.
 */

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  encoding?: string;
  timeout?: number;
  stream?: boolean;
  env?: Record<string, string | undefined>;
}

export interface AdbDevice {
  id: string;
  state: string;
}

export interface Adb {
  readonly executable: string;
  readonly serial: string | null;
  version(): string;
  devices(): AdbDevice[];
  resolveSerial(): string;
  raw(args: string[], options?: RunOptions): CommandResult;
  checked(args: string[], options?: RunOptions): CommandResult;
  shell(command: string, options?: RunOptions): CommandResult;
  shellChecked(command: string, options?: RunOptions): CommandResult;
  push(localPath: string, remotePath: string): void;
  remoteHash(remotePath: string): string | null;
  exists(remotePath: string): boolean;
  isDirectory(remotePath: string): boolean;
  readFile(remotePath: string): string | null;
  writeFile(remotePath: string, contents: string): void;
  remove(remotePath: string): CommandResult;
  remoteSize(remotePath: string): number | null;
  forceStop(packageName: string): void;
  startActivity(component: string): void;
  startLauncher(packageName: string): void;
  isPackageInstalled(packageName: string): boolean;
}

export interface StagedBundle {
  path: string;
  name: string;
  bytes: number;
  hash: string;
}

export declare class DeployError extends Error {
  constructor(message: string, options?: { code?: number });
  readonly code: number;
}

export declare function run(command: string, args: string[], options?: RunOptions): CommandResult;
export declare function runChecked(command: string, args: string[], options?: RunOptions): CommandResult;
export declare function hashOf(input: string | Buffer): string;
export declare function sha256Hex(input: string | Buffer): string;
export declare function exists(path: string): boolean;
export declare function filesEqual(a: string, b: string): boolean;
export declare function copyFileWithParents(source: string, destination: string): void;
export declare function readJsonFile(path: string): unknown;
export declare function writeJsonFile(path: string, value: unknown): void;
export declare function stripBom(text: string): string;
export declare function rotationFolderName(pluginId: string, version: string, now?: Date): string;
export declare function stageBundle(options: {
  source: string;
  stagingDir: string;
  suffix?: "none" | "hash" | "timestamp";
  now?: Date;
}): StagedBundle;
export declare function createAdb(options?: { executable?: string; serial?: string | null; timeoutMs?: number }): Adb;
export declare function withPluginEnabled(
  list: unknown,
  pluginId: string,
): { list: string[]; changed: boolean };
export declare function formatBytes(bytes: number): string;
export declare function createSourceResolver(root: string, bundleSource?: string | null): (name: string) => string;
