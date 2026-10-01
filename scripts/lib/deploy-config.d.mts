/**
 * Types for the deployment configuration module.
 *
 * `scripts/` is plain JavaScript so it can run without a build step, but the
 * regression tests in `test/deploy.test.ts` are TypeScript. This declaration file
 * lets `tsc --noEmit` type-check those tests; keep it in sync with the exports in
 * `deploy-config.mjs`.
 */

/** One parsed `.env` file, keyed by variable name. */
export type DotEnvValues = Record<string, string>;

export interface WindowsDeployConfig {
  readonly platform: "windows";
  readonly target: "windows";
  readonly root: string;
  readonly pluginId: string;
  readonly pluginFiles: readonly string[];
  readonly vault: string;
  readonly vaultRoot: string;
  readonly pluginDir: string;
  readonly registryPath: string;
  readonly restart: boolean;
  readonly mustExit: boolean;
  readonly create: boolean;
  readonly processName: string;
  readonly dryRun: boolean;
  readonly build: DeployBuildConfig;
}

export interface AndroidDeployConfig {
  readonly platform: "android";
  readonly target: "android";
  readonly root: string;
  readonly pluginId: string;
  readonly pluginFiles: readonly string[];
  readonly vault: string;
  readonly vaultName: string;
  readonly vaultRoot: string;
  readonly pluginDir: string;
  readonly rotate: boolean;
  readonly prune: boolean;
  readonly restart: boolean;
  readonly dryRun: boolean;
  readonly build: DeployBuildConfig;
  readonly android: {
    readonly adb: string;
    readonly packageName: string;
    readonly serial: string | null;
    readonly activity: string | null;
    readonly timeoutMs: number;
    readonly registryPath: string;
  };
}

export interface DeployBuildConfig {
  readonly mode: "production" | "development";
  readonly skip: boolean;
  readonly devFile: string;
}

export type DeployConfig = WindowsDeployConfig | AndroidDeployConfig;

export interface ResolveDeployConfigOptions {
  root: string;
  target?: string;
  overrides?: {
    target?: string;
    vault?: string;
    serial?: string;
    build?: string;
    skipBuild?: boolean;
    dryRun?: boolean;
    rotate?: boolean;
    prune?: boolean;
    restart?: boolean;
    create?: boolean;
    force?: boolean;
    pluginId?: string;
    files?: string[];
  };
  repoHas?: (name: string) => boolean;
}

export declare const DEFAULTS: {
  readonly pluginId: string;
  readonly pluginFiles: readonly string[];
  readonly androidDocuments: string;
  readonly androidPackage: string;
  readonly adb: string;
  readonly registryFile: string;
  readonly vaultSubdir: string;
  readonly deviceSetTimeoutMs: number;
};

export declare function readDotEnv(dir: string): DotEnvValues;
export declare function expandPath(value: string, baseDir: string): string;
export declare function toBool(value: string | undefined, fallback: boolean): boolean;
export declare function toInt(value: string | undefined, fallback: number): number;
export declare function toList(value: string | undefined): string[];
export declare function parseAndroidVault(value: string): {
  vaultName: string;
  vaultRoot: string;
  androidRoot: "sdcard" | "storage";
};
export declare function resolveDeployConfig(options: ResolveDeployConfigOptions): DeployConfig;
