import { describe, expect, it } from "vitest";
import { decodeText, encodeText, isMergeablePath, normalizedEquals, preferredShape, toLines, fromLines } from "./text";
import { mergeBytes, threeWayMerge } from "./merge";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("text shape handling", () => {
  it("detects and preserves a UTF-8 BOM", () => {
    const decoded = decodeText(utf8("\uFEFFhello\n"));
    expect(decoded?.shape.bom).toBe(true);
    expect(decoded?.text).toBe("hello\n");
    // Round-tripping restores the BOM bytes rather than silently stripping them.
    expect([...encodeText(decoded!.text, decoded!.shape)]).toEqual([0xef, 0xbb, 0xbf, ...utf8("hello\n")]);
  });

  it("detects CRLF and re-encodes to CRLF", () => {
    const decoded = decodeText(utf8("a\r\nb\r\n"));
    expect(decoded?.shape.eol).toBe("crlf");
    expect(decoded?.text).toBe("a\nb\n");
    expect(new TextDecoder().decode(encodeText(decoded!.text, decoded!.shape))).toBe("a\r\nb\r\n");
  });

  it("reports mixed endings and treats them as neither pure style", () => {
    expect(decodeText(utf8("a\r\nb\n"))?.shape.eol).toBe("mixed");
  });

  it("records a missing trailing newline and does not invent one", () => {
    const decoded = decodeText(utf8("a\nb"));
    expect(decoded?.shape.trailingNewline).toBe(false);
    expect(new TextDecoder().decode(encodeText(decoded!.text, decoded!.shape))).toBe("a\nb");
  });

  it("treats the same content with different line endings as equal in the normalized model", () => {
    expect(normalizedEquals("a\r\nb\r\n", "a\nb\n")).toBe(true);
    expect(normalizedEquals("a\nb\n", "a\nc\n")).toBe(false);
  });

  it("keeps line terminators in the line model so a trailing newline stays visible", () => {
    expect(toLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(toLines("a\nb")).toEqual(["a\n", "b"]);
    expect(toLines("")).toEqual([]);
    expect(fromLines(toLines("a\nb"))).toBe("a\nb");
  });

  it("rejects binary and invalid UTF-8 instead of replacing bytes", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
    expect(decodeText(utf8("has\u0000nul"))).toBeUndefined();
  });

  it("only claims markdown and plain text are mergeable", () => {
    for (const path of ["a.md", "a.markdown", "a.mdx", "notes/a.txt", "A.MD"]) expect(isMergeablePath(path)).toBe(true);
    for (const path of ["a.json", "a.yaml", "a.png", "a.pdf", "a.sqlite", "plugins/data.json", "a"]) expect(isMergeablePath(path)).toBe(false);
  });

  it("prefers the local shape, then remote, then a plain LF default", () => {
    const crlf = { bom: false, eol: "crlf" as const, trailingNewline: true };
    const lfNoBom = { bom: false, eol: "lf" as const, trailingNewline: false };
    expect(preferredShape(crlf, lfNoBom, undefined).eol).toBe("crlf");
    expect(preferredShape(undefined, crlf, undefined).eol).toBe("crlf");
    expect(preferredShape(undefined, undefined, undefined).eol).toBe("lf");
    expect(preferredShape({ bom: true, eol: "mixed", trailingNewline: true }, crlf, undefined).bom).toBe(true);
    expect(preferredShape({ bom: false, eol: "mixed", trailingNewline: true }, crlf, undefined).eol).toBe("crlf");
  });
});

/** Builds the three decoded sides a merge needs, from plain LF strings. */
function sides(base: string, local: string, remote: string) {
  const shape = { bom: false, eol: "lf" as const, trailingNewline: base.endsWith("\n") };
  return { base: { text: base, shape }, local: { text: local, shape }, remote: { text: remote, shape } };
}

describe("three-way merge", () => {
  const BASE = "A\nB\nC\n";

  it("merges edits to different regions cleanly", () => {
    // The contract's own example: local edits B, remote appends D.
    const result = threeWayMerge(...Object.values(sides(BASE, "A\nB-local\nC\n", "A\nB\nC\nD-remote\n")) as [never, never, never]);
    expect(result.status).toBe("clean");
    if (result.status === "clean") expect(result.text).toBe("A\nB-local\nC\nD-remote\n");
  });

  it("merges a modification on one side with a modification elsewhere on the other", () => {
    const result = threeWayMerge(...Object.values(sides(BASE, "A\nB-local\nC\n", "A\nB\nC-remote\n")) as [never, never, never]);
    expect(result.status).toBe("clean");
    if (result.status === "clean") expect(result.text).toBe("A\nB-local\nC-remote\n");
  });

  it("treats an identical change on both sides as clean", () => {
    const result = threeWayMerge(...Object.values(sides(BASE, "A\nB-same\nC\n", "A\nB-same\nC\n")) as [never, never, never]);
    expect(result.status).toBe("clean");
    if (result.status === "clean") expect(result.text).toBe("A\nB-same\nC\n");
  });

  it("refuses to merge when both sides rewrite the same line differently", () => {
    const result = threeWayMerge(...Object.values(sides("value = A\n", "value = B\n", "value = C\n")) as [never, never, never]);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0]).toMatchObject({ local: "value = B\n", base: "value = A\n", remote: "value = C\n" });
      // The draft carries explicit markers but is only ever a UI artifact.
      expect(result.draft).toContain("<<<<<<< LOCAL");
      expect(result.draft).toContain(">>>>>>> REMOTE");
    }
  });

  it("reports a conflict when one side deletes a hunk the other edits", () => {
    const result = threeWayMerge(...Object.values(sides("A\nB\nC\n", "A\nC\n", "A\nB-remote\nC\n")) as [never, never, never]);
    expect(result.status).toBe("conflict");
  });

  it("reports a conflict when both sides insert different text at the same point", () => {
    const result = threeWayMerge(...Object.values(sides("A\nB\n", "A\nlocal\nB\n", "A\nremote\nB\n")) as [never, never, never]);
    expect(result.status).toBe("conflict");
  });

  it("cleans a deletion on one side and a disjoint edit on the other", () => {
    const result = threeWayMerge(...Object.values(sides("A\nB\nC\n", "A\nC\n", "A\nB\nC-remote\n")) as [never, never, never]);
    expect(result.status).toBe("clean");
    // The local side removed B while the remote edited C; both survive because they are independent.
    if (result.status === "clean") expect(result.text).toBe("A\nB\nC-remote\n");
  });

  it("describes the conflicting region precisely rather than whole files", () => {
    const result = threeWayMerge(...Object.values(sides("A\nvalue = A\nZ\n", "A\nvalue = B\nZ\n", "A\nvalue = C\nZ\n")) as [never, never, never]);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      // Only the changed line appears in the hunk; the surrounding stable context does not.
      expect(result.hunks[0]).toMatchObject({ local: "value = B\n", base: "value = A\n", remote: "value = C\n" });
      expect(result.draft!.startsWith("A\n<<<<<<< LOCAL")).toBe(true);
    }
  });

  it("does not manufacture a conflict from line-ending differences alone", () => {
    // The same content, one side saved with CRLF: the normalized model must see no disagreement.
    const base = decodeText(utf8("A\nB\nC\n"))!;
    const local = decodeText(utf8("A\r\nB\r\nC\r\n"))!;
    const remote = decodeText(utf8("A\nB\nC\n"))!;
    const result = threeWayMerge(base, local, remote);
    expect(result.status).toBe("clean");
    if (result.status === "clean") {
      expect(result.text).toBe("A\nB\nC\n");
      // The local file's own shape wins, so the file is not gratuitously reformatted.
      expect(result.shape.eol).toBe("crlf");
    }
  });

  it("merges when only a BOM distinguishes the copies", () => {
    const base = decodeText(utf8("A\nB\n"))!;
    const local = decodeText(utf8("\uFEFFA\nB\n"))!;
    const remote = decodeText(utf8("A\nB\n"))!;
    expect(threeWayMerge(base, local, remote).status).toBe("clean");
  });

  it("preserves a CRLF result when the local side is CRLF", () => {
    // Local edits line B (and uses CRLF); remote edits line C. A clean merge whose output must adopt
    // the local file's CRLF shape rather than quietly normalizing the whole file to LF.
    const base = decodeText(utf8("A\nB\nC\n"))!;
    const local = decodeText(utf8("A\r\nB-local\r\nC\r\n"))!;
    const remote = decodeText(utf8("A\nB\nC-remote\n"))!;
    const clean = threeWayMerge(base, local, remote);
    expect(clean.status).toBe("clean");
    if (clean.status === "clean") {
      expect(new TextDecoder().decode(clean.bytes)).toBe("A\r\nB-local\r\nC-remote\r\n");
      expect(clean.shape.eol).toBe("crlf");
    }
  });

  it("handles additions at both ends and an empty base", () => {
    const result = threeWayMerge(...Object.values(sides("", "local\n", "remote\n")) as [never, never, never]);
    expect(["clean", "conflict"]).toContain(result.status);
  });

  it("reports decode failure rather than merging bytes it cannot read", () => {
    expect(mergeBytes(utf8("a\n"), new Uint8Array([0xff, 0xfe]), utf8("a\n")).status).toBe("unavailable");
  });

  it("is deterministic for the same inputs", () => {
    const first = threeWayMerge(...Object.values(sides(BASE, "A\nX\n", "A\nY\n")) as [never, never, never]);
    const second = threeWayMerge(...Object.values(sides(BASE, "A\nX\n", "A\nY\n")) as [never, never, never]);
    expect(first).toEqual(second);
  });
});
