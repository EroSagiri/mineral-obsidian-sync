/**
 * Text normalization for conflict merge.
 *
 * The merge engine works on a single canonical line model (LF-separated lines, no BOM) and the
 * result is re-encoded back into the file's own shape. That split exists so that a byte-level
 * difference which is *not* a content difference — a CRLF file versus the same file saved with LF,
 * or a BOM appearing or disappearing — cannot manufacture a conflict, while the output still does not
 * gratuitously rewrite the whole file's formatting.
 *
 * Every rule here is deliberately narrow: this layer only understands encoding shape, never meaning.
 * Markdown semantics, JSON re-serialization and the like are explicitly out of scope.
 */

export type LineEnding = "lf" | "crlf" | "mixed";

export interface TextShape {
  /** A UTF-8 byte order mark was present and must be preserved. */
  bom: boolean;
  /** The dominant line ending, or `mixed` when the file genuinely uses both. */
  eol: LineEnding;
  /** Whether the file ended with a newline. */
  trailingNewline: boolean;
}

export interface DecodedText { text: string; shape: TextShape; }

const BOM = "\uFEFF";

/** Extensions the merge engine is allowed to treat as text. Everything else is manual-required. */
export const MERGEABLE_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"] as const;

/** Bodies above this are never snapshotted or merged; the ceiling keeps IndexedDB bounded. */
export const MAX_MERGEABLE_BYTES = 1024 * 1024;

export function isMergeablePath(path: string): boolean {
  const lower = path.toLowerCase();
  return MERGEABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function countLineEndings(text: string): { crlf: number; lf: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // A bare LF is one that is not the tail of a CRLF pair.
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return { crlf, lf };
}

/**
 * Decodes bytes as strict UTF-8. A byte-order mark is detected and stripped, and invalid UTF-8 is
 * rejected rather than silently replaced: a file we cannot decode is a file we must not merge,
 * because any "replacement character" we introduced would be written back as real content.
 */
export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  // `ignoreBOM: true` keeps a leading U+FEFF in the decoded string instead of consuming it. The BOM
  // is detected explicitly below, so letting the decoder silently swallow it would make this
  // function's own `bom` flag unable to ever be true.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let raw: string;
  try { raw = decoder.decode(bytes); }
  catch { return undefined; }
  let bom = false;
  if (raw.startsWith(BOM)) { bom = true; raw = raw.slice(1); }
  if (raw.includes("\u0000")) return undefined; // NUL means this is not a text document.
  const { crlf, lf } = countLineEndings(raw);
  const eol: LineEnding = crlf > 0 && lf > 0 ? "mixed" : crlf > 0 ? "crlf" : "lf";
  return { text: normalizeToLf(raw), shape: { bom, eol, trailingNewline: raw.endsWith("\n") } };
}

function normalizeToLf(raw: string): string { return raw.replace(/\r\n/g, "\n"); }

/**
 * Splits into lines *keeping* their terminators, and drops the final empty element a trailing
 * newline produces. `"a\nb\n"` becomes `["a\n", "b\n"]`, and `"a\nb"` becomes `["a\n", "b"]`, so a
 * trailing-newline difference stays visible in the model instead of being silently erased.
 */
export function toLines(normalizedText: string): string[] {
  if (normalizedText === "") return [];
  const parts = normalizedText.split("\n");
  const lines: string[] = [];
  for (let index = 0; index < parts.length - 1; index++) lines.push(`${parts[index]}\n`);
  const last = parts[parts.length - 1]!;
  if (last !== "") lines.push(last);
  return lines;
}

/** Inverse of {@link toLines}: the line model always carries its own terminators. */
export function fromLines(lines: string[]): string { return lines.join(""); }

/**
 * Chooses the output shape. The local file's own formatting wins, because it is the copy the user was
 * editing; remote is the next best witness; LF without a BOM is the final fallback.
 */
export function preferredShape(local: TextShape | undefined, remote: TextShape | undefined, base: TextShape | undefined): TextShape {
  return {
    bom: local?.bom ?? remote?.bom ?? base?.bom ?? false,
    eol: local && local.eol !== "mixed" ? local.eol : remote && remote.eol !== "mixed" ? remote.eol : base?.eol === "crlf" ? "crlf" : "lf",
    trailingNewline: local?.trailingNewline ?? remote?.trailingNewline ?? base?.trailingNewline ?? true,
  };
}

/** Re-encodes merged LF text into the target shape. Only the shape is applied, never the content. */
export function encodeText(normalizedText: string, shape: TextShape): Uint8Array {
  let text = normalizedText;
  if (!shape.trailingNewline && text.endsWith("\n")) text = text.slice(0, -1);
  else if (shape.trailingNewline && text !== "" && !text.endsWith("\n")) text += "\n";
  if (shape.eol === "crlf") text = text.replace(/\n/g, "\r\n");
  if (shape.bom) text = `${BOM}${text}`;
  return new TextEncoder().encode(text);
}

/**
 * Line-model equality. Two texts are equal when their normalized line models match, which is what
 * lets a pure line-ending change be recognized as "not a content change".
 */
export function normalizedEquals(left: string, right: string): boolean { return normalizeToLf(left) === normalizeToLf(right); }
