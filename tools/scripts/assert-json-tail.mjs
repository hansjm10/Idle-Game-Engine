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

  let parsed;
  let lastError;
  let errorCandidate = '';
  // Walk upward ignoring trailing noise until we accumulate a full JSON block (covers compact and pretty output).
  for (let tailIndex = lines.length - 1; tailIndex >= 0; tailIndex -= 1) {
    let working = '';
    for (let index = tailIndex; index >= 0; index -= 1) {
      working = working.length > 0 ? `${lines[index]}\n${working}` : lines[index];
      try {
        parsed = JSON.parse(working);
        break;
      } catch (error) {
        lastError = error;
        errorCandidate = working;
      }
    }

    if (parsed) {
      break;
    }
  }

  if (!parsed) {
    console.error(
      [
        `Failed to parse trailing JSON payload in ${absolutePath}.`,
        `Payload:`,
        errorCandidate.length > 0 ? errorCandidate : '(no viable JSON candidate found)',
        lastError instanceof Error ? lastError.message : String(lastError),
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
