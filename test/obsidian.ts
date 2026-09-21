type Handler = (request: { url: string; method?: string; headers?: Record<string, string>; throw?: boolean }) => Promise<unknown>;
let handler: Handler = async () => { throw new Error("requestUrl mock was not configured"); };

export function setRequestUrlHandler(next: Handler): void { handler = next; }
export async function requestUrl(request: { url: string; method?: string; headers?: Record<string, string>; throw?: boolean }): Promise<unknown> { return handler(request); }
