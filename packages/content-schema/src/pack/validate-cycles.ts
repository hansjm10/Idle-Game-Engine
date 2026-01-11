import { z } from 'zod';

import type { Condition } from '../base/conditions.js';
import type { NumericFormula } from '../base/formulas.js';
import type { TransformDefinition } from '../modules/transforms.js';
import type { ParsedContentPack } from './schema.js';
import { toMutablePath } from './utils.js';

/**
 * Type definitions for cycle detection
 */
type AdjacencyGraph = Map<string, Set<string>>;
type CyclePath = string[];
type TransformConversion = {
  readonly inputResourceId: string;
  readonly outputResourceId: string;
  readonly ratio: number;
};

const PROFIT_EPSILON = 1e-8;
const compareIds = (left: string, right: string) => left.localeCompare(right);

/**
 * Normalizes a cycle path to its canonical form for deduplication.
 * The canonical form starts with the lexicographically smallest element.
 * For example: [B, C, A, B] becomes [A, B, C, A]
 */
const normalizeCyclePath = (cyclePath: CyclePath): string => {
  if (cyclePath.length <= 1) {
    return cyclePath.join('→');
  }

  // Remove the duplicate last element for rotation
  const cycle = cyclePath.slice(0, -1);

  // Find the index of the lexicographically smallest element
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) {
      minIndex = i;
    }
  }

  // Rotate the cycle to start with the smallest element
  const normalized = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
  // Add the first element again to close the cycle
  normalized.push(normalized[0]);

  return normalized.join('→');
};

/**
 * Generic cycle detection using DFS with path tracking.
 * Returns detected cycles (deduplicated and optionally stopping at first cycle).
 *
 * @param adjacency - The graph represented as an adjacency list
 * @param nodes - The nodes to check for cycles
 * @param stopAtFirst - If true, stops after finding the first cycle (default: true for performance)
 * @returns Array of cycle paths
 */
const detectCycles = (
  adjacency: AdjacencyGraph,
  nodes: Iterable<string>,
  stopAtFirst = true,
): CyclePath[] => {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: CyclePath = [];
  const cycles: CyclePath[] = [];
  const seenCycles = new Set<string>();

  const visit = (node: string): boolean => {
    if (stack.has(node)) {
      // Cycle detected! Build the cycle path
      const cycleStartIndex = path.indexOf(node);
      const cyclePath: CyclePath = [...path.slice(cycleStartIndex), node];

      // Normalize and deduplicate
      const normalizedCycle = normalizeCyclePath(cyclePath);
      if (!seenCycles.has(normalizedCycle)) {
        seenCycles.add(normalizedCycle);
        cycles.push(cyclePath);

        // Early termination if requested
        if (stopAtFirst) {
          return true; // Signal to stop
        }
      }
      return false;
    }

    if (visited.has(node)) {
      return false;
    }

    visited.add(node);
    stack.add(node);
    path.push(node);

    const edges = adjacency.get(node);
    if (edges) {
      for (const target of edges) {
        if (visit(target)) {
          return true; // Propagate early termination
        }
      }
    }

    stack.delete(node);
    path.pop();
    return false;
  };

  // Check all nodes for cycles
  for (const nodeId of nodes) {
    if (!visited.has(nodeId)) {
      if (visit(nodeId)) {
        break; // Early termination
      }
    }
  }

  return cycles;
};

const getConstantFormulaValue = (formula: NumericFormula): number | undefined => {
  if (formula.kind !== 'constant') {
    return undefined;
  }
  return formula.value;
};

const buildTransformConversion = (
  transform: TransformDefinition,
): TransformConversion | undefined => {
  if (transform.inputs.length !== 1 || transform.outputs.length !== 1) {
    return undefined;
  }
  const input = transform.inputs[0];
  const output = transform.outputs[0];
  const inputAmount = getConstantFormulaValue(input.amount);
  const outputAmount = getConstantFormulaValue(output.amount);
  if (inputAmount === undefined || outputAmount === undefined) {
    return undefined;
  }
  if (inputAmount <= 0 || outputAmount <= 0) {
    return undefined;
  }
  const ratio = outputAmount / inputAmount;
  if (!Number.isFinite(ratio)) {
    return undefined;
  }
  return {
    inputResourceId: input.resourceId,
    outputResourceId: output.resourceId,
    ratio,
  };
};

const getCycleRatio = (
  cyclePath: CyclePath,
  conversions: ReadonlyMap<string, TransformConversion>,
): number | undefined => {
  let ratio = 1;
  for (let i = 0; i < cyclePath.length - 1; i += 1) {
    const current = conversions.get(cyclePath[i]);
    const next = conversions.get(cyclePath[i + 1]);
    if (!current || !next) {
      return undefined;
    }
    if (current.outputResourceId !== next.inputResourceId) {
      return undefined;
    }
    ratio *= current.ratio;
    if (!Number.isFinite(ratio)) {
      return undefined;
    }
  }
  return ratio;
};

const findCycleFromNode = (
  startId: string,
  adjacency: AdjacencyGraph,
): CyclePath | undefined => {
  const edges = adjacency.get(startId);
  if (edges?.has(startId)) {
    return [startId, startId];
  }

  const queue: string[] = [startId];
  const visited = new Set<string>([startId]);
  const previous = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const targets = adjacency.get(current);
    if (!targets) {
      continue;
    }
    for (const next of targets) {
      if (next === startId) {
        return buildCyclePath(previous, startId, current);
      }
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }

  return undefined;
};

function buildCyclePath(
  previous: ReadonlyMap<string, string>,
  startId: string,
  current: string,
): CyclePath | undefined {
  const path: string[] = [current];
  let cursor = current;
  while (cursor !== startId) {
    const parent = previous.get(cursor);
    if (!parent) {
      return undefined;
    }
    cursor = parent;
    path.push(cursor);
  }

  path.reverse();
  path.push(startId);
  return path;
}

const findNetPositiveCycle = (
  transformIds: readonly string[],
  adjacency: AdjacencyGraph,
  conversions: ReadonlyMap<string, TransformConversion>,
): CyclePath | undefined => {
  if (transformIds.length === 0) {
    return undefined;
  }

  const indexById = new Map<string, number>();
  transformIds.forEach((id, index) => {
    indexById.set(id, index);
  });

  const edges: { from: number; to: number; weight: number }[] = [];
  transformIds.forEach((fromId) => {
    const conversion = conversions.get(fromId);
    if (!conversion) {
      return;
    }
    const targets = adjacency.get(fromId);
    if (!targets) {
      return;
    }
    const fromIndex = indexById.get(fromId);
    if (fromIndex === undefined) {
      return;
    }
    const weight = -Math.log(conversion.ratio);
    targets.forEach((toId) => {
      const toIndex = indexById.get(toId);
      if (toIndex === undefined) {
        return;
      }
      edges.push({ from: fromIndex, to: toIndex, weight });
    });
  });

  if (edges.length === 0) {
    return undefined;
  }

  // Bellman-Ford algorithm for negative cycle detection.
  //
  // Key technique: Zero-initialized distances (not infinity). This is a standard
  // approach for detecting negative cycles in any graph component without requiring
  // a virtual source node connected to all vertices. When distances start at zero,
  // any negative cycle will eventually reduce some distance below zero, triggering
  // detection via the N-th relaxation iteration.
  //
  // Weight transformation: Edge weights are -log(ratio), so:
  //   - net-positive cycles (product of ratios > 1) become negative-weight cycles
  //   - net-loss cycles (product of ratios < 1) become positive-weight cycles
  // This allows standard shortest-path algorithms to detect profitable cycles.
  const distances = new Array(transformIds.length).fill(0);
  const previous = new Array<number>(transformIds.length).fill(-1);
  let updatedIndex = -1;

  const n = transformIds.length;
  for (let i = 0; i < n; i += 1) {
    updatedIndex = -1;
    for (const edge of edges) {
      if (distances[edge.to] > distances[edge.from] + edge.weight) {
        distances[edge.to] = distances[edge.from] + edge.weight;
        previous[edge.to] = edge.from;
        updatedIndex = edge.to;
      }
    }
  }

  if (updatedIndex === -1) {
    return undefined;
  }

  let cycleIndex = updatedIndex;
  for (let i = 0; i < n; i += 1) {
    const prevIndex = previous[cycleIndex];
    if (prevIndex === -1) {
      return undefined;
    }
    cycleIndex = prevIndex;
  }

  const cycleIndices: number[] = [];
  const seen = new Set<number>();
  let current = cycleIndex;
  while (!seen.has(current)) {
    seen.add(current);
    cycleIndices.push(current);
    const prevIndex = previous[current];
    if (prevIndex === -1) {
      return undefined;
    }
    current = prevIndex;
  }

  cycleIndices.reverse();
  cycleIndices.push(cycleIndices[0]);
  return cycleIndices.map((index) => transformIds[index]);
};

export const validateTransformCycles = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
) => {
  // Build a graph where nodes are transforms and edges are resource dependencies
  // Edge from transform A to transform B exists when:
  // A produces a resource that B consumes as input
  const adjacency = new Map<string, Set<string>>();
  const transformIndex = new Map<string, number>();
  const transformById = new Map<string, TransformDefinition>();
  const conversions = new Map<string, TransformConversion>();
  const nonSimpleTransforms: string[] = [];

  // Index all transforms by their output resources
  const resourceProducers = new Map<string, Set<string>>();

  pack.transforms.forEach((transform, index) => {
    transformIndex.set(transform.id, index);
    transformById.set(transform.id, transform);
    const conversion = buildTransformConversion(transform);
    if (conversion) {
      conversions.set(transform.id, conversion);
    } else {
      nonSimpleTransforms.push(transform.id);
    }

    transform.outputs.forEach((output) => {
      if (!resourceProducers.has(output.resourceId)) {
        resourceProducers.set(output.resourceId, new Set());
      }
      resourceProducers.get(output.resourceId)?.add(transform.id);
    });
  });

  // Build the adjacency graph based on resource dependencies
  pack.transforms.forEach((transform) => {
    transform.inputs.forEach((input) => {
      const producers = resourceProducers.get(input.resourceId);
      if (producers) {
        producers.forEach((producerId) => {
          // Add edge from producer to consumer
          if (!adjacency.has(producerId)) {
            adjacency.set(producerId, new Set());
          }
          adjacency.get(producerId)?.add(transform.id);
        });
      }
    });
  });

  const reportCycleIssue = (cyclePath: CyclePath, profitabilityNote: string) => {
    const cycleDescription = cyclePath.join(' → ');
    const firstNodeInCycle = cyclePath[0];
    const index = transformIndex.get(firstNodeInCycle);

    // Collect resources involved in the cycle
    const involvedResources = new Set<string>();
    for (let i = 0; i < cyclePath.length - 1; i++) {
      const currentTransformId = cyclePath[i];
      const nextTransformId = cyclePath[i + 1];

      // Find the transform objects
      const currentTransform = transformById.get(currentTransformId);
      const nextTransform = transformById.get(nextTransformId);

      if (currentTransform && nextTransform) {
        // Find resources produced by current that are consumed by next
        currentTransform.outputs.forEach((output) => {
          if (nextTransform.inputs.some((input) => input.resourceId === output.resourceId)) {
            involvedResources.add(output.resourceId);
          }
        });
      }
    }

    const resourceList = Array.from(involvedResources)
      .sort(compareIds)
      .join(', ');
    const resourceContext = involvedResources.size > 0
      ? ` (involves resources: ${resourceList})`
      : '';

    if (index !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['transforms', index] as const),
        message: `Transform cycle detected: ${cycleDescription}${resourceContext}. ${profitabilityNote} Consider breaking the cycle by: (1) introducing external resource sources via generators or initial grants, (2) converting to a linear transformation chain, or (3) adjusting inputs/outputs to create a net-loss conversion.`,
      });
    }
  };

  for (const transformId of nonSimpleTransforms) {
    const cyclePath = findCycleFromNode(transformId, adjacency);
    if (cyclePath) {
      reportCycleIssue(
        cyclePath,
        `Cycle profitability cannot be evaluated because transform '${transformId}' does not have exactly one input and one output with constant positive amounts.`,
      );
      return;
    }
  }

  const netPositiveCycle = findNetPositiveCycle(
    Array.from(conversions.keys()),
    adjacency,
    conversions,
  );
  if (netPositiveCycle) {
    const ratio = getCycleRatio(netPositiveCycle, conversions);
    if (ratio === undefined || ratio > 1 + PROFIT_EPSILON) {
      reportCycleIssue(
        netPositiveCycle,
        'Net-positive transform cycles are not allowed.',
      );
    }
  }
};

export const validateUnlockConditionCycles = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
) => {
  // Build a graph where nodes are entities (resources, generators, upgrades, etc.)
  // and edges represent unlock dependencies
  const adjacency = new Map<string, Set<string>>();

  // Track entity types and indices for error reporting
  type EntityInfo = {
    type: 'resource' | 'generator' | 'upgrade' | 'achievement' | 'transform' | 'prestige';
    index: number;
  };
  const entityMap = new Map<string, EntityInfo>();

  // Helper to extract entity references from conditions
  type ConditionReferenceContext = {
    readonly entityId: string;
    readonly entityType: EntityInfo['type'];
  };

  const extractConditionReferences = (
    condition: Condition | undefined,
    context?: ConditionReferenceContext,
  ): Set<string> => {
    const refs = new Set<string>();

    if (!condition) {
      return refs;
    }

    const visit = (node: Condition) => {
      switch (node.kind) {
        case 'resourceThreshold': {
          if (context?.entityType === 'resource' && context.entityId === node.resourceId) {
            break;
          }
          refs.add(node.resourceId);
          break;
        }
        case 'generatorLevel':
          refs.add(node.generatorId);
          break;
        case 'upgradeOwned':
          refs.add(node.upgradeId);
          break;
        case 'prestigeCountThreshold':
          refs.add(`${node.prestigeLayerId}-prestige-count`);
          break;
        case 'prestigeCompleted':
          refs.add(`${node.prestigeLayerId}-prestige-count`);
          break;
        case 'prestigeUnlocked':
          refs.add(node.prestigeLayerId);
          break;
        case 'allOf':
          node.conditions.forEach(visit);
          break;
        case 'anyOf':
        case 'not':
          // Non-monotonic predicates are excluded from unlock dependency edges.
          break;
        case 'always':
        case 'never':
        case 'flag':
        case 'script':
          // These conditions don't reference game entities, so no unlock dependencies
          break;
        default: {
          // Exhaustive check - TypeScript will error if new kinds are added
          const _exhaustive: never = node;
          return _exhaustive;
        }
      }
    };

    visit(condition);
    return refs;
  };

  // Index all entities
  pack.resources.forEach((resource, index) => {
    entityMap.set(resource.id, { type: 'resource', index });
  });
  pack.generators.forEach((generator, index) => {
    entityMap.set(generator.id, { type: 'generator', index });
  });
  pack.upgrades.forEach((upgrade, index) => {
    entityMap.set(upgrade.id, { type: 'upgrade', index });
  });
  pack.achievements.forEach((achievement, index) => {
    entityMap.set(achievement.id, { type: 'achievement', index });
  });
  pack.transforms.forEach((transform, index) => {
    entityMap.set(transform.id, { type: 'transform', index });
  });
  pack.prestigeLayers.forEach((layer, index) => {
    entityMap.set(layer.id, { type: 'prestige', index });
  });

  // Build adjacency graph for resources
  pack.resources.forEach((resource) => {
    if (resource.unlockCondition) {
      const refs = extractConditionReferences(resource.unlockCondition, {
        entityId: resource.id,
        entityType: 'resource',
      });
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(resource.id);
      });
    }
  });

  // Build adjacency graph for generators
  pack.generators.forEach((generator) => {
    if (generator.baseUnlock) {
      const refs = extractConditionReferences(generator.baseUnlock);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(generator.id);
      });
    }
  });

  // Build adjacency graph for upgrades
  pack.upgrades.forEach((upgrade) => {
    if (upgrade.unlockCondition) {
      const refs = extractConditionReferences(upgrade.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(upgrade.id);
      });
    }
    // Also check prerequisites (which are Condition objects)
    upgrade.prerequisites.forEach((prereqCondition) => {
      const refs = extractConditionReferences(prereqCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(upgrade.id);
      });
    });
  });

  // Build adjacency graph for achievements
  pack.achievements.forEach((achievement) => {
    if (achievement.unlockCondition) {
      const refs = extractConditionReferences(achievement.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(achievement.id);
      });
    }
  });

  // Build adjacency graph for transforms
  pack.transforms.forEach((transform) => {
    if (transform.unlockCondition) {
      const refs = extractConditionReferences(transform.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(transform.id);
      });
    }
  });

  // Build adjacency graph for prestige layers
  pack.prestigeLayers.forEach((layer) => {
    if (layer.unlockCondition) {
      const refs = extractConditionReferences(layer.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(layer.id);
      });
    }
  });

  // Mapping from entity type to pack array property name
  const entityTypePaths: Record<EntityInfo['type'], string> = {
    resource: 'resources',
    generator: 'generators',
    upgrade: 'upgrades',
    achievement: 'achievements',
    transform: 'transforms',
    prestige: 'prestigeLayers',
  };

  // Detect cycles using the generic helper
  // Uses early termination (stopAtFirst=true by default) for performance
  const cycles = detectCycles(adjacency, entityMap.keys());

  // Report detected cycle (at most one due to early termination)
  for (const cyclePath of cycles) {
    const cycleDescription = cyclePath.join(' → ');
    const firstNodeInCycle = cyclePath[0];
    const entityInfo = entityMap.get(firstNodeInCycle);

    // Collect entity types involved in the cycle
    const involvedTypes = new Set<string>();
    cyclePath.forEach((entityId) => {
      const info = entityMap.get(entityId);
      if (info) {
        involvedTypes.add(info.type);
      }
    });

    const typeList = Array.from(involvedTypes)
      .sort(compareIds)
      .join(', ');
    let typeContext = '';
    if (involvedTypes.size > 0) {
      const typeDescription =
        involvedTypes.size === 1 ? typeList : `entity types: ${typeList}`;
      typeContext = ` (involves ${typeDescription})`;
    }

    if (entityInfo) {
      const pathPrefix = [entityTypePaths[entityInfo.type], entityInfo.index] as const;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(pathPrefix),
        message: `Unlock condition cycle detected: ${cycleDescription}${typeContext}. Consider fixing by: (1) introducing a base entity that both depend on, (2) removing one unlock condition to create a hierarchical progression, or (3) using a flag or other non-entity condition to break the cycle.`,
      });
    }
  }
};
