import { createHash } from 'crypto';

export { computeContentDigest } from './digest.js';

export function computeArtifactHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
