export interface MockRequestUrlRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  throw?: boolean;
}

export interface MockRequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
  json?: unknown;
}

/** Mirrors the fields the plugin reads; tests run in a desktop-like Node environment. */
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

/**
 * Vault file classes, minimal but real classes so `instanceof` checks behave as they do in Obsidian.
 *
 * `TFile.stat` is present because the plugin reads it directly on the desktop scan path.
 */
export class TFile {
  path = "";
  stat = { size: 0, mtime: 0, ctime: 0 };
}

export class TFolder {
  path = "";
}

/**
 * `MarkdownView` stand-in.
 *
 * A plugin-level test needs three things from it: an `instanceof` target for the workspace listeners,
 * the editor buffer, and a `save()` whose effect on the file a test can script. Everything else in the
 * real class is irrelevant to the code under test.
 */
export class MarkdownView {
  file: TFile | null = null;
  editor: { getValue(): string } = { getValue: () => "" };
  saved = 0;
  async save(): Promise<void> { this.saved += 1; }
}

/** Records the controls a settings tab adds, so a tab can be constructed without a DOM. */
export class PluginSettingTab {
  constructor(public app: unknown, public plugin: unknown) {}
  display(): void {}
}

/**
 * `Plugin` stand-in.
 *
 * Only the base-class surface `main.ts` touches is implemented, and every registration is a no-op: a
 * test constructs the plugin and drives the method it is interested in, rather than an `onload()` that
 * would need sockets, timers and a whole Vault.
 */
export class Plugin {
  app: unknown;
  manifest: { id: string; dir?: string } = { id: "mineral-obsidian-sync" };
  constructor(app?: unknown, manifest?: { id: string; dir?: string }) {
    this.app = app;
    if (manifest) this.manifest = manifest;
  }
  addSettingTab(): void {}
  addCommand(): void {}
  addStatusBarItem(): { setText(text: string): void } { return { setText: () => {} }; }
  registerEvent(): void {}
  registerInterval(handle: unknown): unknown { return handle; }
  registerDomEvent(): void {}
  async loadData(): Promise<unknown> { return null; }
  async saveData(): Promise<void> {}
  async onload(): Promise<void> {}
  onunload(): void {}
}

type Handler = (request: MockRequestUrlRequest) => Promise<MockRequestUrlResponse>;

let handler: Handler = async () => {
  throw new Error("requestUrl mock was not configured");
};

export function setRequestUrlHandler(next: Handler): void {
  handler = next;
}

export function resetRequestUrlHandler(): void {
  handler = async () => {
    throw new Error("requestUrl mock was not configured");
  };
}

/**
 * Faithful enough to pin the transport's most important parameter: Obsidian rejects on any status
 * >= 400 **unless** the caller passed `throw: false`. The mock honours `throw` for the same reason,
 * so removing `throw: false` from `RequestUrlTransport` fails the suite instead of passing silently.
 */
export async function requestUrl(request: MockRequestUrlRequest): Promise<MockRequestUrlResponse> {
  const response = await handler(request);
  if (request.throw !== false && response.status >= 400) throw new Error(`Request failed with status code ${response.status}`);
  return response;
}

/**
 * Minimal `Modal` stand-in.
 *
 * Tests drive a modal's own `onOpen` against a fake element rather than a DOM, because the plugin's
 * modal code only creates elements and assigns text. The class exists here so a modal can extend it;
 * `open()` records that it was opened, which is what a caller-level test needs to observe.
 */
export class Modal {
  containerEl: unknown = undefined;
  contentEl: unknown = undefined;
  titleEl: unknown = undefined;
  modalEl: unknown = undefined;
  scope: unknown = undefined;
  opened = false;
  constructor(public app: unknown) {}
  open(): void { this.opened = true; }
  close(): void { this.opened = false; this.onClose(); }
  onOpen(): void {}
  onClose(): void {}
}

export class Notice {
  static readonly shown: string[] = [];
  constructor(public message: string) { Notice.shown.push(message); }
  setMessage(message: string): this { this.message = message; return this; }
  hide(): void {}
}

export function setIcon(): void {}

/**
 * Minimal `Setting` stand-in.
 *
 * It records the label and handler of every control a caller adds, which is all a modal test needs to
 * drive the modal's own logic. It deliberately does not emulate Obsidian's real DOM structure.
 */
export class Setting {
  /**
   * Every button every Setting registered, in creation order. A modal test needs a way to press a
   * Setting-hosted control, and this is the smallest surface that makes that possible without
   * emulating Obsidian's DOM.
   */
  static readonly registered: Array<{ text: string; callback: () => void }> = [];
  readonly buttons: Array<{ text: string; callback: () => void }> = [];
  name?: string;
  constructor(public containerEl: unknown) {}
  setName(value?: string): this { this.name = value; return this; }
  setDesc(): this { return this; }
  setHeading(): this { return this; }
  setClass(): this { return this; }
  addButton(callback: (button: { setButtonText(text: string): unknown; setCta(): unknown; onClick(handler: () => void): unknown }) => unknown): this {
    let label = "";
    const button = {
      setButtonText: (text: string) => { label = text; return button; },
      setCta: () => button,
      onClick: (handler: () => void) => {
        const entry = { text: label, callback: handler };
        this.buttons.push(entry);
        Setting.registered.push(entry);
        return button;
      },
    };
    callback(button);
    return this;
  }
}

/**
 * Minimal `Menu` stand-in.
 *
 * It records the title and handler of every item a caller adds, in creation order, which is all a test
 * needs to press a context-menu entry. As with `Setting.addButton`, the item is recorded when its
 * `onClick` is registered rather than on `showAtPosition`, because the item's identity and handler are
 * the caller's own logic; the popup itself is Obsidian's.
 */
export class Menu {
  /**
   * Every menu built since the module loaded, in creation order.
   *
   * The menu itself is the only object a caller hands to Obsidian, so a test that wants to press an
   * entry has no other reference to reach for. Mirrors `Notice.shown`.
   */
  static readonly shown: Menu[] = [];
  readonly items: Array<{ title: string; icon: string; callback: () => void }> = [];
  constructor() { Menu.shown.push(this); }
  addItem(callback: (item: MenuStubItem) => unknown): this {
    let title = "";
    let icon = "";
    const item: MenuStubItem = {
      setTitle: (text: string) => { title = text; return item; },
      setIcon: (name: string) => { icon = name; return item; },
      onClick: (handler: () => void) => {
        this.items.push({ title, icon, callback: handler });
        return item;
      },
    };
    callback(item);
    return this;
  }
  showAtPosition(): void {}
  showAtMouseEvent(): void {}
}

/** The item shape `Menu.addItem` passes to its callback, as far as this stub supports it. */
export interface MenuStubItem {
  setTitle(title: string): MenuStubItem;
  setIcon(name: string): MenuStubItem;
  onClick(handler: () => void): MenuStubItem;
}
