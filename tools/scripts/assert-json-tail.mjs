#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

async function main() {
  const [targetPath, expectedEvent] = process.argv.slice(2);
  if (!targetPath) {
    console.error(
      'Usage: node tools/scripts/assert-json-tail.mjs <log-file> [expectedEvent]',
    );
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  let raw;
  try {
    raw = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    console.error(
      `Failed to read log file at ${absolutePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    console.error(
      `No non-empty lines found in log file at ${absolutePath}. Expected structured JSON output.`,
    );
    process.exit(1);
  }

  const tailLine = lines[lines.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(tailLine);
  } catch (error) {
    console.error(
      [
        `Failed to parse trailing line of ${absolutePath} as JSON.`,
        `Line: ${tailLine}`,
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
    process.exit(1);
  }

  if (typeof expectedEvent === 'string' && expectedEvent.length > 0) {
    const actualEvent = typeof parsed.event === 'string' ? parsed.event : undefined;
    if (actualEvent !== expectedEvent) {
      console.error(
        `Tail event mismatch in ${absolutePath}: expected "${expectedEvent}", received "${actualEvent ?? '<missing>'}".`,
      );
      process.exit(1);
    }
  }

  console.log(
    `Structured tail event confirmed for ${absolutePath}: ${String(parsed.event ?? '<unnamed>')}`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
