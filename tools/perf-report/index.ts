import {promises as fs} from 'node:fs';
import path from 'node:path';
import {collectBenchmarkArtifacts, renderMarkdown} from './lib.js';

async function main(): Promise<void> {
  const artifacts = await collectBenchmarkArtifacts();
  const markdown = renderMarkdown(artifacts);

  const outputDir = path.join('docs', 'performance');
  await fs.mkdir(outputDir, {recursive: true});
  await fs.writeFile(path.join(outputDir, 'index.md'), `${markdown.trimEnd()}\n`);
}

main().catch((error) => {
  console.error('[perf-report] Failed to generate markdown performance report.');
  console.error(error);
  process.exit(1);
});
