import { telemetry } from '../telemetry.js';
import type { System, SystemDefinition } from './system-types.js';

export interface SystemHost {
  addSystem(system: System): void;
}

export interface RegisterSystemsResult {
  readonly order: readonly string[];
}

export function registerSystems(
  host: SystemHost,
  definitions: readonly SystemDefinition[],
): RegisterSystemsResult {
  if (definitions.length === 0) {
    return { order: [] };
  }

  const systemsById = new Map<string, SystemDefinition>();
  const orderIndex = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  definitions.forEach((definition, index) => {
    if (systemsById.has(definition.id)) {
      throw new Error(`System "${definition.id}" registered multiple times.`);
    }
    systemsById.set(definition.id, definition);
    orderIndex.set(definition.id, index);
    adjacency.set(definition.id, new Set());
    indegree.set(definition.id, 0);
  });

  for (const definition of definitions) {
    const { id, after, before } = definition;

    if (Array.isArray(after)) {
      for (const dependency of after) {
        if (dependency === id) {
          throw new Error(`System "${id}" cannot depend on itself.`);
        }
        if (!systemsById.has(dependency)) {
          throw new Error(`System "${id}" declares unknown dependency "${dependency}".`);
        }
        const targets = adjacency.get(dependency)!;
        if (!targets.has(id)) {
          targets.add(id);
          indegree.set(id, (indegree.get(id) ?? 0) + 1);
        }
      }
    }

    if (Array.isArray(before)) {
      for (const successor of before) {
        if (successor === id) {
          throw new Error(`System "${id}" cannot declare before itself.`);
        }
        if (!systemsById.has(successor)) {
          throw new Error(`System "${id}" declares unknown successor "${successor}".`);
        }
        const targets = adjacency.get(id)!;
        if (!targets.has(successor)) {
          targets.add(successor);
          indegree.set(successor, (indegree.get(successor) ?? 0) + 1);
        }
      }
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort((left, right) => compareByOrder(left, right, orderIndex));

  const resolvedOrder: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    resolvedOrder.push(next);

    for (const successor of adjacency.get(next) ?? []) {
      const nextDegree = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, nextDegree);
      if (nextDegree === 0) {
        insertSorted(ready, successor, orderIndex);
      }
    }
  }

  if (resolvedOrder.length !== definitions.length) {
    const remaining = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id)
      .sort();

    telemetry.recordError('SystemDependencyCycle', {
      unresolved: remaining,
    });
    throw new Error(
      `System dependency graph contains a cycle involving: ${remaining.join(', ')}`,
    );
  }

  for (const systemId of resolvedOrder) {
    const definition = systemsById.get(systemId)!;
    host.addSystem(definition);
  }

  return {
    order: Object.freeze([...resolvedOrder]),
  };
}

function insertSorted(list: string[], value: string, orderIndex: Map<string, number>): void {
  const index = findInsertIndex(list, value, orderIndex);
  list.splice(index, 0, value);
}

function findInsertIndex(list: string[], value: string, orderIndex: Map<string, number>): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (compareByOrder(list[mid]!, value, orderIndex) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function compareByOrder(left: string, right: string, orderIndex: Map<string, number>): number {
  const leftIndex = orderIndex.get(left);
  const rightIndex = orderIndex.get(right);
  if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
