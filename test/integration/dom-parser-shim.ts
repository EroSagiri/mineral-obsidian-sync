/**
 * Minimal test-only `DOMParser` for the flat ListObjectsV2 XML that R2 and the in-process
 * emulator return. Node has no DOMParser, and Obsidian always does, so this shim exists only
 * so the paginated list path can be exercised outside Obsidian.
 */

interface ShimNode {
  readonly tagName: string;
  readonly textContent: string;
  getElementsByTagName(name: string): ShimList;
}

type ShimList = ShimNode[] & { item(index: number): ShimNode | undefined };

function listOf(nodes: ShimNode[]): ShimList {
  return Object.assign([...nodes], { item: (index: number) => nodes[index] });
}

function simpleTags(xml: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of xml.matchAll(/<([A-Za-z0-9_.:-]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
    values.set(match[1]!, decodeXml(match[2] ?? ""));
  }
  return values;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

class ShimElement implements ShimNode {
  constructor(readonly tagName: string, private readonly values: Map<string, string> = new Map(), private readonly own: string = "") {}

  get textContent(): string {
    return this.own;
  }

  getElementsByTagName(name: string): ShimList {
    if (this.tagName === name) return listOf([this]);
    const value = this.values.get(name);
    return value === undefined ? listOf([]) : listOf([new ShimElement(name, new Map(), value)]);
  }
}

class ShimDocument {
  constructor(private readonly root: ShimElement, private readonly contents: ShimElement[], private readonly valid: boolean) {}

  get documentElement(): ShimElement {
    return this.root;
  }

  getElementsByTagName(name: string): ShimList {
    if (name === "Contents") return listOf(this.contents);
    if (name === this.root.tagName) return listOf([this.root]);
    return this.root.getElementsByTagName(name);
  }

  querySelector(selector: string): ShimNode | null {
    return selector === "parsererror" && !this.valid ? new ShimElement("parsererror") : null;
  }
}

export class ShimDOMParser {
  parseFromString(xml: string): ShimDocument {
    const contents: ShimElement[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) contents.push(new ShimElement("Contents", simpleTags(match[1] ?? "")));
    const outer = xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, "");
    const rootTag = /<([A-Za-z0-9_.:-]+)[\s>]/.exec(outer)?.[1];
    return new ShimDocument(new ShimElement(rootTag ?? "document", simpleTags(outer)), contents, rootTag !== undefined);
  }
}

export function installDomParserShim(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (typeof scope.DOMParser === "undefined") scope.DOMParser = ShimDOMParser;
}
