import {promises as fs} from 'node:fs';
import path from 'node:path';
import {aggregateTotals, collectPackageSummaries, renderMarkdown} from './lib.js';

async function main(): Promise<void> {
  const packages = await collectPackageSummaries();
  const totals = aggregateTotals(packages);
  const markdown = renderMarkdown({
    packages,
    totals
  });

  const outputDir = path.join('docs', 'coverage');
  await fs.mkdir(outputDir, {recursive: true});
  await fs.writeFile(path.join(outputDir, 'index.md'), `${markdown.trimEnd()}\n`);
}

main().catch((error) => {
  console.error('[coverage-report] Failed to generate markdown coverage report.');
  console.error(error);
  process.exit(1);
});
