import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {renderMarkdown, type BenchmarkArtifact} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('renderMarkdown includes benchmark sections', async () => {
  const artifacts = await loadFixture();
  const markdown = renderMarkdown(artifacts);

  assert.match(markdown, /title: Performance Report/);
  assert.match(markdown, /## event-frame-format/);
  assert.match(markdown, /\| Scenario \| Events\/Tick \|/);
  assert.match(markdown, /## diagnostic-timeline-overhead/);
  assert.match(markdown, /## state-sync-checksum/);
});

async function loadFixture(): Promise<BenchmarkArtifact[]> {
  const fixturePath = path.resolve(__dirname, '__fixtures__/sample-artifacts.json');
  const data = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  return data.artifacts as BenchmarkArtifact[];
}
