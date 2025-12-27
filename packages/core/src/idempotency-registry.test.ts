import { describe, expect, it } from 'vitest';

import type { CommandResponse } from './command-transport.js';
import { InMemoryIdempotencyRegistry } from './idempotency-registry.js';

const createResponse = (
  requestId: string,
  status: CommandResponse['status'],
  serverStep: number,
): CommandResponse => ({
  requestId,
  status,
  serverStep,
});

describe('InMemoryIdempotencyRegistry', () => {
  it('returns recorded responses for duplicate keys', () => {
    const registry = new InMemoryIdempotencyRegistry();
    const response = createResponse('req-1', 'accepted', 10);

    registry.record('client-a:req-1', response, 1000);

    expect(registry.get('client-a:req-1')).toBe(response);
    expect(registry.get('client-a:req-2')).toBeUndefined();
  });

  it('purges entries when the TTL has expired', () => {
    const registry = new InMemoryIdempotencyRegistry();
    const responseA = createResponse('req-a', 'accepted', 1);
    const responseB = createResponse('req-b', 'duplicate', 2);

    registry.record('client-a:req-a', responseA, 50);
    registry.record('client-a:req-b', responseB, 150);

    registry.purgeExpired(50);

    expect(registry.get('client-a:req-a')).toBeUndefined();
    expect(registry.get('client-a:req-b')).toBe(responseB);
    expect(registry.size()).toBe(1);
  });

  it('overwrites stored responses for the same key', () => {
    const registry = new InMemoryIdempotencyRegistry();
    const responseA = createResponse('req-a', 'accepted', 1);
    const responseB = createResponse('req-a', 'rejected', 2);

    registry.record('client-a:req-a', responseA, 100);
    registry.record('client-a:req-a', responseB, 200);

    expect(registry.get('client-a:req-a')).toBe(responseB);
    expect(registry.size()).toBe(1);
  });
});
