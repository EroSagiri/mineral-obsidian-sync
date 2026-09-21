/** Byte helpers shared by the integration scenarios. Binary payloads are never decoded as UTF-8. */

export function utf8(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return toArrayBuffer(encoded);
}

/** Always returns an exactly-sized, detached copy so no caller can mutate shared bytes. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function sameBytes(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** Web Crypto caps a single `getRandomValues` call at 65,536 bytes, so larger payloads are chunked. */
const RANDOM_CHUNK = 65_536;

export function randomBytes(size: number): Uint8Array {
  const output = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += RANDOM_CHUNK) {
    crypto.getRandomValues(output.subarray(offset, Math.min(offset + RANDOM_CHUNK, size)));
  }
  return output;
}
