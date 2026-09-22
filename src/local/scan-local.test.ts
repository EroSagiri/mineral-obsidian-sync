import { describe, expect, it } from "vitest";
import { scanLocalAdapterMetadata } from "./scan-local";

describe("scanLocalAdapterMetadata", () => {
  it("uses adapter metadata rather than stale in-memory file metadata", async () => {
    const vault = {
      getFiles: () => [{ path: "note.md", stat: { size: 1, mtime: 1 } }],
      adapter: { stat: async () => ({ size: 9, mtime: 99 }) },
    };
    const result = await scanLocalAdapterMetadata(vault as never, { ignores: () => false });
    expect(result.get("note.md")).toEqual({ key: "note.md", size: 9, mtime: 99 });
  });
});
