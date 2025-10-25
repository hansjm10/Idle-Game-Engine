import { describe, expect, it } from 'vitest';

import type { System } from './system-types.js';
import { registerSystems } from './system-registry.js';

describe('system-registry', () => {
  it('registers systems sorted by dependency constraints', () => {
    const registered: string[] = [];
    const host = createHost((system) => {
      registered.push(system.id);
    });

    const { order } = registerSystems(host, [
      createSystem('production', { before: ['events'] }),
      createSystem('events'),
      createSystem('upgrades', { after: ['production'] }),
    ]);

    expect(order).toEqual(['production', 'events', 'upgrades']);
    expect(registered).toEqual(order);
  });

  it('throws when encountering unknown dependencies', () => {
    const host = createHost(() => {});

    expect(() =>
      registerSystems(host, [
        createSystem('a', { after: ['missing'] }),
      ]),
    ).toThrowError(/unknown dependency "missing"/);
  });

  it('throws on dependency cycles and records telemetry context', () => {
    const host = createHost(() => {});

    expect(() =>
      registerSystems(host, [
        createSystem('a', { after: ['b'] }),
        createSystem('b', { after: ['a'] }),
      ]),
    ).toThrowError(/cycle/);
  });

  it('rejects duplicate system identifiers', () => {
    const host = createHost(() => {});

    expect(() =>
      registerSystems(host, [
        createSystem('duplicate'),
        createSystem('duplicate'),
      ]),
    ).toThrowError(/registered multiple times/);
  });

  it('allows dependencies that reference systems already registered on the host', () => {
    const registered: string[] = [];
    const host = createHost((system) => {
      registered.push(system.id);
    }, ['events']);

    const { order } = registerSystems(host, [
      createSystem('achievements', { after: ['events'] }),
      createSystem('automation', { after: ['achievements'] }),
    ]);

    expect(order).toEqual(['achievements', 'automation']);
    expect(registered).toEqual(order);
  });

  it('throws when declaring a before constraint against an existing host system', () => {
    const host = createHost(() => {}, ['events']);

    expect(() =>
      registerSystems(host, [
        createSystem('achievements', { before: ['events'] }),
      ]),
    ).toThrowError(/before already registered system "events"/);
  });
});

function createSystem(
  id: string,
  overrides?: Partial<Omit<System, 'id' | 'tick'>> & {
    readonly before?: readonly string[];
    readonly after?: readonly string[];
  },
): System & { readonly before?: readonly string[]; readonly after?: readonly string[] } {
  return {
    id,
    tick: () => {},
    ...overrides,
  };
}

function createHost(register: (system: System) => void, existing: readonly string[] = []) {
  const registeredIds = new Set(existing);
  return {
    addSystem(system: System) {
      registeredIds.add(system.id);
      register(system);
    },
    hasSystem(systemId: string) {
      return registeredIds.has(systemId);
    },
  };
}
