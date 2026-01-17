import canonicalize from 'canonicalize';

import type {
  RenderCommandBuffer,
  Sha256Hex,
  ViewModel,
} from './types.js';

const textEncoder = new TextEncoder();

export function canonicalizeForHash(value: unknown): string {
  const normalized = normalizeNumbersForHash(value);
  const result = canonicalize(normalized);

  if (typeof result !== 'string') {
    throw new Error('Failed to canonicalize value for hashing.');
  }

  return result;
}

export function canonicalEncodeForHash(value: unknown): Uint8Array {
  const json = canonicalizeForHash(value);
  return textEncoder.encode(json);
}

export async function sha256Hex(bytes: Uint8Array): Promise<Sha256Hex> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('WebCrypto is unavailable (globalThis.crypto.subtle is missing).');
  }

  const digest = await subtle.digest('SHA-256', toArrayBuffer(bytes));

  return bufferToHex(new Uint8Array(digest));
}

export async function hashViewModel(viewModel: ViewModel): Promise<Sha256Hex> {
  return sha256Hex(canonicalEncodeForHash(viewModel));
}

export async function hashRenderCommandBuffer(
  rcb: RenderCommandBuffer,
): Promise<Sha256Hex> {
  return sha256Hex(canonicalEncodeForHash(rcb));
}

function bufferToHex(bytes: Uint8Array): Sha256Hex {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;

  if (buffer instanceof ArrayBuffer) {
    if (byteOffset === 0 && byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  return new Uint8Array(bytes).buffer;
}

function normalizeNumbersForHash(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'number': {
      if (Number.isNaN(value)) {
        throw new Error('Failed to hash value: encountered NaN.');
      }
      if (!Number.isFinite(value)) {
        throw new Error('Failed to hash value: encountered Infinity.');
      }
      if (Object.is(value, -0)) {
        return 0;
      }
      return value;
    }
    case 'string':
    case 'boolean':
      return value;
    case 'bigint':
      throw new Error('Failed to hash value: encountered bigint.');
    case 'symbol':
      throw new Error('Failed to hash value: encountered symbol.');
    case 'function':
      throw new Error('Failed to hash value: encountered function.');
    case 'undefined':
      return undefined;
    case 'object': {
      if (value instanceof Map) {
        throw new Error('Failed to hash value: encountered Map.');
      }
      if (value instanceof Set) {
        throw new Error('Failed to hash value: encountered Set.');
      }
      if (Array.isArray(value)) {
        return value.map(normalizeNumbersForHash);
      }
      if (!isPlainObject(value)) {
        throw new Error('Failed to hash value: encountered non-plain object.');
      }

      const normalized: Record<string, unknown> = Object.create(null);
      for (const [key, entryValue] of Object.entries(value)) {
        normalized[key] = normalizeNumbersForHash(entryValue);
      }
      return normalized;
    }
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export { normalizeNumbersForHash };
