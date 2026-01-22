
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, '../../../../');
const docsPath = resolve(repoRoot, 'docs/content-schema-reference.md');

const upgradesPath = resolve(repoRoot, 'packages/content-schema/src/modules/upgrades.ts');
const achievementsPath = resolve(repoRoot, 'packages/content-schema/src/modules/achievements.ts');
const automationsPath = resolve(repoRoot, 'packages/content-schema/src/modules/automations.ts');
const conditionsPath = resolve(repoRoot, 'packages/content-schema/src/base/conditions.ts');

const readDocs = () => readFileSync(docsPath, 'utf8');
const readFile = (path: string) => readFileSync(path, 'utf8');

const sliceSection = (markdown: string, heading: string, nextHeading?: string) => {
  const start = markdown.indexOf(heading);
  if (start < 0) {
    throw new Error(`Heading "${heading}" not found in docs.`);
  }
  const end = nextHeading ? markdown.indexOf(nextHeading, start) : -1;
  return end > start ? markdown.slice(start, end) : markdown.slice(start);
};

// Helper to extract items from a markdown table
// Assumes items are in the first column as `code` blocks
const extractTableItems = (markdownFragment: string): string[] => {
  // Allow for optional whitespace around the pipes
  const matches = [...markdownFragment.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)];
  return matches.map((m) => m[1]);
};

describe('docs/content-schema-reference.md', () => {
  it('documents all Upgrade Categories', () => {
    const docs = readDocs();
    const source = readFile(upgradesPath);

    const section = sliceSection(docs, '## Upgrade Categories', '## Achievement Track Kinds');
    const documented = extractTableItems(section);

    // Extract from source: category: z.enum(['global', 'resource', 'generator', 'automation', 'prestige'] as const)
    // We match the array content inside z.enum([...])
    const match = source.match(/category: z\.enum\(\[([^\]]+)\]/);
    if (!match) throw new Error('Could not find category enum in upgrades.ts');
    
    const codeValues = match[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, '')) // remove quotes
      .filter(s => s.length > 0);

    expect(new Set(documented)).toEqual(new Set(codeValues));
  });

  it('documents all Achievement Track Kinds', () => {
    const docs = readDocs();
    const source = readFile(achievementsPath);

    const section = sliceSection(docs, '## Achievement Track Kinds', '## Automation Target Types');
    const documented = extractTableItems(section);

    // Extract from source: inside trackSchema = z.discriminatedUnion('kind', [...])
    // We look for kind: z.literal('value')
    // We need to limit the search to the trackSchema definition to avoid picking up other things
    
    const trackSchemaStart = source.indexOf('const trackSchema =');
    const trackSchemaEnd = source.indexOf(']);', trackSchemaStart);
    const trackSchemaBlock = source.slice(trackSchemaStart, trackSchemaEnd);

    const codeValues = [...trackSchemaBlock.matchAll(/kind: z\.literal\('([^']+)'\)/g)]
      .map(m => m[1]);

    expect(new Set(documented)).toEqual(new Set(codeValues));
  });

  it('documents all Automation Target Types', () => {
    const docs = readDocs();
    const source = readFile(automationsPath);

    const section = sliceSection(docs, '## Automation Target Types', '## Condition Kinds');
    const documented = extractTableItems(section);

    // Extract from source: targetType: z.enum(['generator', 'upgrade', ...])
    const match = source.match(/targetType: z\.enum\(\s*\[([^\]]+)\]/);
    if (!match) throw new Error('Could not find targetType enum in automations.ts');

    const codeValues = match[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0);

    expect(new Set(documented)).toEqual(new Set(codeValues));
  });

  it('documents all Condition Kinds', () => {
    const docs = readDocs();
    const source = readFile(conditionsPath);

    const section = sliceSection(docs, '## Condition Kinds', '### Examples');
    const documented = extractTableItems(section);

    // Extract from source: inside createConditionSchema ... discriminatedUnion('kind', [...])
    // Look for kind: z.literal('value')
    
    // We can just grab all z.literal matches for 'kind' in the file, 
    // assuming they are all part of the condition kinds in this file (which is true for conditions.ts)
    // But be careful if there are other unions. 
    // In conditions.ts, there is `createConditionSchema` which defines the main union.
    
    const createSchemaStart = source.indexOf('const createConditionSchema =');
    const createSchemaEnd = source.indexOf(']);', createSchemaStart);
    const createSchemaBlock = source.slice(createSchemaStart, createSchemaEnd);

    const codeValues = [...createSchemaBlock.matchAll(/kind: z\.literal\('([^']+)'\)/g)]
      .map(m => m[1]);

    expect(new Set(documented)).toEqual(new Set(codeValues));
  });
});
