import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as fc from 'fast-check';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createFormulaArbitrary,
  createFormulaEvaluationContextArbitrary,
  DEFAULT_FORMULA_PROPERTY_SEED,
  evaluateNumericFormula,
  type ExpressionNode,
  type FormulaEvaluationContext,
  type NumericFormula,
} from '@idle-engine/content-schema';

import {
  ContentPackValidationError,
  validateContentPacks,
} from '../generate.js';

const PACK_SLUG = 'property-pack';
const BASE_RESOURCES = [
  'resource/property/base',
  'resource/property/output',
] as const;
const FORMULA_REFERENCE_RESOURCES = [
  'resource/property/ref-alpha',
  'resource/property/ref-beta',
  'resource/property/ref-gamma',
] as const;
const ALL_RESOURCES = [...BASE_RESOURCES, ...FORMULA_REFERENCE_RESOURCES] as const;

const FORMULA_REFERENCE_POOLS = {
  resource: FORMULA_REFERENCE_RESOURCES,
  generator: [] as const,
  upgrade: [] as const,
  automation: [] as const,
  prestigeLayer: [] as const,
};

const PROPERTY_MANIFEST_DEFINITIONS = [{ type: 'runtime.event.property' }];

const PROPERTY_NUM_RUNS = 32;

const propertyConfig = (offset: number): fc.Parameters<unknown> => ({
  numRuns: PROPERTY_NUM_RUNS,
  seed: DEFAULT_FORMULA_PROPERTY_SEED + 500 + offset,
  endOnFailure: true,
});

describe('validateContentPacks property suites', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts generated formulas and preserves sanitized evaluation invariants', async () => {
    const formulaArb = createFormulaArbitrary({
      referencePools: FORMULA_REFERENCE_POOLS,
    });
    const contextArb = createFormulaEvaluationContextArbitrary(
      FORMULA_REFERENCE_POOLS,
    );

    await fc.assert(
      fc.asyncProperty(
        formulaArb,
        contextArb,
        async (formula, context) => {
          const workspace = await createWorkspace(buildPackDocument(formula, ALL_RESOURCES));
          const consoleCapture = captureConsole();

          try {
            const result = await validateContentPacks(
              PROPERTY_MANIFEST_DEFINITIONS,
              { rootDirectory: workspace.root },
            );

            expect(result.schemaOptions.activePackIds).toEqual([PACK_SLUG]);

            const validationEvent = consoleCapture.events.find(
              (event) =>
                event?.event === 'content_pack.validated' &&
                event?.packSlug === PACK_SLUG,
            );
            expect(validationEvent?.warningCount ?? 0).toBe(0);

            const normalizedContext = cloneContext(context);
            const levelFloor = Math.max(
              0,
              Math.floor(normalizedContext.variables.level),
            );
            const lowContext = setContextLevel(normalizedContext, levelFloor);
            const highContext = setContextLevel(normalizedContext, levelFloor + 1);

            const lowValue = evaluateNumericFormula(formula, lowContext);
            const highValue = evaluateNumericFormula(formula, highContext);

            expect(Number.isFinite(lowValue)).toBe(true);
            expect(Number.isFinite(highValue)).toBe(true);
            expect(lowValue).toBeGreaterThanOrEqual(0);
            expect(highValue).toBeGreaterThanOrEqual(0);
            expect(highValue + Number.EPSILON).toBeGreaterThanOrEqual(lowValue);
          } finally {
            consoleCapture.restore();
            await workspace.cleanup();
          }
        },
      ),
      propertyConfig(0),
    );
  }, 30_000);

  it('rejects formulas that reference unknown resources with actionable failures', async () => {
    const expressionFormulaArb = createFormulaArbitrary({
      referencePools: FORMULA_REFERENCE_POOLS,
      kinds: ['expression'],
      maxExpressionDepth: 3,
    }).filter((formula) => collectResourceReferences(formula).size > 0);

    await fc.assert(
      fc.asyncProperty(expressionFormulaArb, async (formula) => {
        const referencedIds = collectResourceReferences(formula);
        expect(referencedIds.size).toBeGreaterThan(0);

        const workspace = await createWorkspace(
          buildPackDocument(formula, BASE_RESOURCES),
        );
        const consoleCapture = captureConsole();

        try {
          let caught: unknown;
          try {
            await validateContentPacks(PROPERTY_MANIFEST_DEFINITIONS, {
              rootDirectory: workspace.root,
            });
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(ContentPackValidationError);
          const summary = (caught as ContentPackValidationError).failures[0];
          expect(summary).toBeDefined();

          const issueMessages =
            summary?.issues?.map((issue: { message?: string }) => issue?.message) ?? [];
          expect(
            issueMessages.some(
              (message) =>
                typeof message === 'string' &&
                message.includes('Formula references unknown resource'),
            ),
          ).toBe(true);

          const failureEvent = consoleCapture.errors.find(
            (event) =>
              event?.event === 'content_pack.validation_failed' &&
              event?.path?.includes('pack.json'),
          );
          expect(failureEvent?.issues).toBeDefined();
        } finally {
          consoleCapture.restore();
          await workspace.cleanup();
        }
      }),
      propertyConfig(1),
    );
  }, 30_000);
});

const captureConsole = () => {
  const events: unknown[] = [];
  const errors: unknown[] = [];

  const parsePayload = (value: unknown) => {
    const serialized = typeof value === 'string' ? value : String(value);
    try {
      return JSON.parse(serialized);
    } catch {
      return serialized;
    }
  };

  const logSpy = vi.spyOn(console, 'log').mockImplementation((value) => {
    events.push(parsePayload(value));
  });

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((value) => {
    events.push(parsePayload(value));
  });

  const errorSpy = vi.spyOn(console, 'error').mockImplementation((value) => {
    errors.push(parsePayload(value));
  });

  return {
    events,
    errors,
    restore() {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
};

const buildPackDocument = (
  formula: NumericFormula,
  resourceIds: readonly string[],
) => {
  const resources = resourceIds.map((id, index) =>
    createResourceDefinition(id, index),
  );

  return {
    metadata: {
      id: PACK_SLUG,
      title: { default: 'Property Test Pack', variants: {} },
      version: '0.0.1',
      engine: '^0.1.0',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
    },
    resources,
    generators: [
      {
        id: 'generator/property-core',
        name: { default: 'Property Generator', variants: {} },
        produces: [
          {
            resourceId: BASE_RESOURCES[1],
            rate: formula,
          },
        ],
        consumes: [],
        purchase: {
          currencyId: BASE_RESOURCES[0],
          baseCost: 1,
          costCurve: {
            kind: 'constant',
            value: 1,
          },
        },
        baseUnlock: {
          kind: 'always',
        },
        order: 1,
      },
    ],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
  };
};

const createResourceDefinition = (id: string, order: number) => ({
  id,
  name: { default: `Resource ${order + 1}`, variants: {} },
  category: id === BASE_RESOURCES[0] ? 'currency' : 'primary',
  tier: 1,
  startAmount: id === BASE_RESOURCES[0] ? 10 : 0,
  capacity: id === BASE_RESOURCES[0] || id === BASE_RESOURCES[1] ? 100 : null,
  visible: true,
  unlocked: true,
  order,
});

const createWorkspace = async (document: ReturnType<typeof buildPackDocument>) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-cli-property-'));
  const packDir = path.join(root, 'packages', PACK_SLUG, 'content');
  await fs.mkdir(packDir, { recursive: true });
  await writeJson(path.join(packDir, 'pack.json'), document);

  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
};

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, serialized, 'utf8');
};

const cloneContext = (context: FormulaEvaluationContext): FormulaEvaluationContext =>
  JSON.parse(JSON.stringify(context));

const setContextLevel = (
  context: FormulaEvaluationContext,
  level: number,
): FormulaEvaluationContext => ({
  ...context,
  variables: {
    ...context.variables,
    level,
  },
});

const collectResourceReferences = (formula: NumericFormula): Set<string> => {
  const references = new Set<string>();

  const visitFormula = (node: NumericFormula) => {
    switch (node.kind) {
      case 'piecewise':
        node.pieces.forEach((piece) => visitFormula(piece.formula));
        break;
      case 'expression':
        visitExpression(node.expression);
        break;
      default:
        break;
    }
  };

  const visitExpression = (expression: ExpressionNode) => {
    switch (expression.kind) {
      case 'ref':
        if (expression.target.type === 'resource') {
          references.add(expression.target.id);
        }
        break;
      case 'binary':
        visitExpression(expression.left);
        visitExpression(expression.right);
        break;
      case 'unary':
        visitExpression(expression.operand);
        break;
      case 'call':
        expression.args?.forEach((arg) => visitExpression(arg));
        break;
      default:
        break;
    }
  };

  visitFormula(formula);
  return references;
};
