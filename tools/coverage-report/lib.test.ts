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

  assert.deepEqual(totals.statements, {covered: 80, total: 100});
  assert.deepEqual(totals.branches, {covered: 40, total: 60});
  assert.deepEqual(totals.functions, {covered: 30, total: 40});
  assert.deepEqual(totals.lines, {covered: 70, total: 90});
});

test('renderMarkdown produces deterministic tables', async () => {
  const packages = await loadFixture();
  const markdown = renderMarkdown({
    packages,
    totals: aggregateTotals(packages)
  });

  assert.match(markdown, /---\ntitle: Coverage Report\nsidebar_label: Coverage Report\n---/);
  assert.match(markdown, /\| Metric \| Covered \| Total \| % \|/);
  assert.match(markdown, /\| Statements \| 80 \| 100 \| 80\.00% \|/);
  assert.match(markdown, /\| @idle-engine\/core \| 80 \/ 100 \(80\.00%\)/);
});

async function loadFixture(): Promise<PackageSummary[]> {
  const fixturePath = path.resolve(__dirname, '__fixtures__/sample-summary.json');
  const data = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  return data.packages as PackageSummary[];
}
