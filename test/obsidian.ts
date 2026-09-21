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
