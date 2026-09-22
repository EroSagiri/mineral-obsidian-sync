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
