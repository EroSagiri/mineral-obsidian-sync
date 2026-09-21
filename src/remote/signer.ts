import { AwsV4Signer } from "aws4fetch";
import type { CredentialProvider } from "./credentials";

export type RequestBody = ArrayBuffer | string;
export interface UnsignedRequest { method: string; url: string; headers?: Record<string, string>; body?: RequestBody; }
export interface SignedRequest { method: string; url: string; headers: Record<string, string>; body?: RequestBody; }
export interface RequestSigner { sign(request: UnsignedRequest): Promise<SignedRequest>; }

/** Public aws4fetch sign-only API; this class never calls AwsClient.fetch(). */
export class Aws4FetchSigner implements RequestSigner {
  constructor(private readonly credentials: CredentialProvider, private readonly now: () => Date = () => new Date()) {}

  async sign(request: UnsignedRequest): Promise<SignedRequest> {
    const credentials = await this.credentials.getCredentials();
    const signed = await new AwsV4Signer({
      method: request.method, url: request.url, headers: request.headers, body: request.body,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: "s3",
      region: "auto",
      datetime: this.now().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    }).sign();
    // Host is signed, but requestUrl derives it from the immutable URL and rejects an explicit Host header.
    const headers: Record<string, string> = {};
    signed.headers.forEach((value, name) => { if (name.toLowerCase() !== "host") headers[name === "authorization" ? "Authorization" : name] = value; });
    return { method: signed.method, url: signed.url.toString(), headers, body: signed.body as RequestBody | undefined };
  }
}
