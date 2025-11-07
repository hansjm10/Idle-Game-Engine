import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {aggregateTotals, renderMarkdown, type PackageSummary} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('aggregateTotals sums package metrics', async () => {
  const packages = await loadFixture();
  const totals = aggregateTotals(packages);

  assert.deepEqual(totals.statements, {covered: 130, total: 170});
  assert.deepEqual(totals.branches, {covered: 60, total: 100});
  assert.deepEqual(totals.functions, {covered: 55, total: 75});
  assert.deepEqual(totals.lines, {covered: 125, total: 165});
});

test('renderMarkdown produces deterministic tables', async () => {
  const packages = await loadFixture();
  const markdown = renderMarkdown({
    generatedAt: new Date('2025-11-07T00:00:00Z'),
    packages,
    totals: aggregateTotals(packages)
  });

  assert.match(markdown, /---\ntitle: Coverage Report\nsidebar_label: Coverage Report\n---/);
  assert.match(markdown, /\| Metric \| Covered \| Total \| % \|/);
  assert.match(markdown, /\| Statements \| 130 \| 170 \| 76\.47% \|/);
  assert.match(markdown, /\| @idle-engine\/core \| 80 \/ 100 \(80\.00%\)/);
  assert.match(markdown, /\| @idle-engine\/shell-web \| 50 \/ 70 \(71\.43%\)/);
  assert.ok(markdown.includes('_Last updated: 2025-11-07T00:00:00.000Z_'));
});

async function loadFixture(): Promise<PackageSummary[]> {
  const fixturePath = path.resolve(__dirname, '__fixtures__/sample-summary.json');
  const data = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  return data.packages as PackageSummary[];
}
