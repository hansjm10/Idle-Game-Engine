import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FEATURE_GATES } from '../runtime-compat.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, '../../../../');
const usageGuidePath = resolve(repoRoot, 'docs/content-dsl-usage-guidelines.md');

const readGuide = () => readFileSync(usageGuidePath, 'utf8');

const sliceSection = (markdown: string, heading: string, nextHeading?: string) => {
  const start = markdown.indexOf(heading);
  if (start < 0) {
    throw new Error(`Heading "${heading}" not found in usage guide.`);
  }
  const end = nextHeading ? markdown.indexOf(nextHeading, start) : -1;
  return end > start ? markdown.slice(start, end) : markdown.slice(start);
};

describe('docs/content-dsl-usage-guidelines.md', () => {
  it('lists every FEATURE_GATES entry in the compatibility matrix', () => {
    const guide = readGuide();
    const compatibilitySection = sliceSection(
      guide,
      '## Compatibility Triage',
      '### Migration matrix',
    );

    const rowMatches = [...compatibilitySection.matchAll(/\| `([^`]+)` \| `([^`]+)` \s*\|/g)];
    expect(rowMatches.length).toBeGreaterThanOrEqual(FEATURE_GATES.length);

    const docModules = new Map(rowMatches.map(([, module, introducedIn]) => [module, introducedIn]));

    expect(
      Array.from(docModules.keys()).sort(),
    ).toEqual(
      FEATURE_GATES.map((gate) => gate.module).sort(),
    );

    FEATURE_GATES.forEach((gate) => {
      expect(docModules.get(gate.module)).toBe(gate.introducedIn);
    });
  });

  it('documents dependency policies in the compatibility matrix', () => {
    const guide = readGuide();
    const dependencySection = sliceSection(
      guide,
      '### Dependency compatibility matrix',
      '## Versioning & Release Cadence',
    );

    const dependencyRows = [...dependencySection.matchAll(/\| `([^`]+)` \|/g)];
    const policies = dependencyRows.map(([, policy]) => policy).filter((policy) => policy !== 'Policy');

    expect(new Set(policies)).toEqual(new Set(['requires', 'optional', 'conflicts', 'provides']));
  });
});
