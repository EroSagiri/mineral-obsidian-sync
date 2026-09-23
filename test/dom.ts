/**
 * Minimal DOM stand-in for the plugin's modals.
 *
 * The plugin ships no DOM test environment, and adding one for two UI files is a large dependency for a
 * small surface. These modals only create elements, assign text, toggle classes and attach click
 * handlers, so the shim provides exactly that — which also means a test cannot accidentally assert on
 * layout behaviour it does not really exercise.
 */
export interface FakeElementOptions {
  text?: string;
  cls?: string;
  attr?: Record<string, string>;
}

export class FakeElement {
  children: FakeElement[] = [];
  text = "";
  value = "";
  rows = 0;
  /** Mirrors `<details>`: closed unless a test or the code opens it. */
  open = false;
  style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly tag: string;

  constructor(tag: string) { this.tag = tag; }

  createEl(tag: string, options: FakeElementOptions = {}): FakeElement {
    const child = new FakeElement(tag);
    this.apply(child, options);
    this.children.push(child);
    return child;
  }
  createDiv(options: FakeElementOptions = {}): FakeElement { return this.createEl("div", options); }
  createSpan(options: FakeElementOptions = {}): FakeElement { return this.createEl("span", options); }
  empty(): void { this.children = []; this.text = ""; }
  remove(): void { /* detached in this shim */ }
  addClass(...names: string[]): void { for (const name of names) if (name) this.classes.add(name); }
  removeClass(...names: string[]): void { for (const name of names) this.classes.delete(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, callback: (event?: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
  }
  click(): void { for (const callback of this.listeners.get("click") ?? []) callback(); }

  private apply(element: FakeElement, options: FakeElementOptions): void {
    if (options.text !== undefined) element.text = options.text;
    if (options.cls) element.addClass(...options.cls.split(" "));
    if (options.attr) for (const [name, value] of Object.entries(options.attr)) element.setAttribute(name, value);
  }

  /** Test helper: the first element in this subtree that the predicate accepts. */
  find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    // Walked through a locally typed visitor rather than a `this`-typed recursion, so the predicate
    // cannot be dragged into the class's polymorphic `this` type.
    const search = (element: FakeElement): FakeElement | undefined => {
      if (predicate(element)) return element;
      for (const child of element.children) { const found = search(child); if (found) return found; }
      return undefined;
    };
    return search(this);
  }

  /** Test helper: every element in this subtree that the predicate accepts. */
  findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const matches: FakeElement[] = [];
    const collect = (element: FakeElement): void => {
      if (predicate(element)) matches.push(element);
      for (const child of element.children) collect(child);
    };
    collect(this);
    return matches;
  }

  /** Test helper: all text in this subtree, which is how "what the user can read" is asserted. */
  get allText(): string {
    return [this.text, ...this.children.map((child) => child.allText)].filter(Boolean).join("\n");
  }
  /** Test helper: all text outside any `<details>` subtree — i.e. the default, unexpanded view. */
  get visibleText(): string {
    if (this.tag === "details") return "";
    return [this.text, ...this.children.map((child) => child.visibleText)].filter(Boolean).join("\n");
  }
  /** Test helper: a button by its exact label. */
  button(label: string): FakeElement | undefined { return this.find((element) => element.tag === "button" && element.text === label); }
}

/** The real `Modal` base class owns `contentEl`; this assigns the shim in its place. */
export function installModalContainer(modal: { contentEl: unknown }, container: FakeElement): void {
  (modal as { contentEl: FakeElement }).contentEl = container;
}

export const flush = async (): Promise<void> => { for (let index = 0; index < 64; index++) await Promise.resolve(); };
