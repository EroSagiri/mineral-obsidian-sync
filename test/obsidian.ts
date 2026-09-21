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

export async function requestUrl(request: MockRequestUrlRequest): Promise<MockRequestUrlResponse> {
  return handler(request);
}
