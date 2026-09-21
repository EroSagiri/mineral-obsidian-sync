/** Scenario result model, failure signalling, and report rendering for integration self-tests. */

export type ScenarioStatus = "pass" | "fail" | "skipped";

export interface ScenarioObservation {
  name: string;
  value: string | number | boolean;
}

export interface ScenarioResult {
  name: string;
  status: ScenarioStatus;
  detail: string;
  observations: ScenarioObservation[];
}

export interface ScenarioReport {
  runId: string;
  /** Always inside `.mineral-sync-test/`. */
  root: string;
  /** Identifies which transport actually ran: `obsidian-requesturl` is the only real one. */
  environment: string;
  startedAt: number;
  finishedAt: number;
  results: ScenarioResult[];
}

export class ScenarioFailure extends Error {
  constructor(message: string, readonly observations: ScenarioObservation[] = []) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

export function require(condition: unknown, message: string, observations: ScenarioObservation[] = []): asserts condition {
  if (!condition) throw new ScenarioFailure(message, observations);
}

export function observation(name: string, value: string | number | boolean): ScenarioObservation {
  return { name, value };
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return raw.replace(/\s+/g, " ").slice(0, 240);
}

/** Runs one scenario, converting a throw into a structured failure instead of aborting the run. */
export async function runScenario(name: string, body: () => Promise<ScenarioObservation[]>): Promise<ScenarioResult> {
  try {
    return { name, status: "pass", detail: "ok", observations: await body() };
  } catch (error) {
    if (error instanceof ScenarioFailure) return { name, status: "fail", detail: error.message, observations: error.observations };
    return { name, status: "fail", detail: errorMessage(error), observations: [] };
  }
}

export function skipScenario(name: string, detail: string): ScenarioResult {
  return { name, status: "skipped", detail, observations: [] };
}

export function summarize(report: ScenarioReport): { passed: number; failed: number; skipped: number } {
  return {
    passed: report.results.filter((entry) => entry.status === "pass").length,
    failed: report.results.filter((entry) => entry.status === "fail").length,
    skipped: report.results.filter((entry) => entry.status === "skipped").length,
  };
}

export function formatReport(report: ScenarioReport): string {
  const { passed, failed, skipped } = summarize(report);
  const lines = [
    `Mineral Sync R2 integration self-test — environment: ${report.environment}`,
    `test root (only prefix this run may touch): ${report.root}`,
    `started:  ${new Date(report.startedAt).toISOString()}`,
    `finished: ${new Date(report.finishedAt).toISOString()}`,
    `result:   ${passed} passed, ${failed} failed, ${skipped} skipped`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`[${result.status.toUpperCase()}] ${result.name} — ${result.detail}`);
    for (const entry of result.observations) lines.push(`    ${entry.name}: ${entry.value}`);
  }
  return lines.join("\n");
}

/**
 * Removes anything that looks like a credential or a signed URL from a report before it is
 * shown, logged, or pasted into an issue.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) if (secret && secret.length >= 4) output = output.split(secret).join("[redacted]");
  return output
    .replace(/AWS4-HMAC-SHA256[^\s]*/gi, "[authorization]")
    .replace(/https?:\/\/[^\s"']+/gi, "[url]")
    .replace(/x-amz-security-token[=:]\s*[^\s,;]+/gi, "x-amz-security-token=[redacted]");
}

export function redactReport(report: ScenarioReport, secrets: readonly string[]): ScenarioReport {
  return {
    ...report,
    results: report.results.map((result) => ({
      ...result,
      detail: redact(result.detail, secrets),
      observations: result.observations.map((entry) => ({ name: entry.name, value: typeof entry.value === "string" ? redact(entry.value, secrets) : entry.value })),
    })),
  };
}
