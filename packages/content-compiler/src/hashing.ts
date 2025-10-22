import { createHash } from 'crypto';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const textEncoder = new TextEncoder();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((entry) => stableStringify(entry));
    return `[${items.join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const serializedProps = entries.map(
    ([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
  );

  return `{${serializedProps.join(',')}}`;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

export function computeContentDigest(input: unknown): string {
  const serialized = stableStringify(input);
  const bytes = textEncoder.encode(serialized);

  return fnv1a(bytes);
}

export function computeArtifactHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
