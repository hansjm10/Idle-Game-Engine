#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function printUsageAndExit() {
  console.error(
    'Usage: node tools/scripts/assert-json-tail.mjs <log-file> [expectedEvent]',
  );
  process.exit(1);
}

async function readLogFile(absolutePath) {
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read log file at ${absolutePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getNonEmptyLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function tryParseJsonCandidate(lines, tailIndex) {
  let working = '';
  let lastError;

  for (let index = tailIndex; index >= 0; index -= 1) {
    working = working.length > 0 ? `${lines[index]}\n${working}` : lines[index];
    try {
      return { parsed: JSON.parse(working), errorCandidate: working, lastError: undefined };
    } catch (error) {
      lastError = error;
    }
  }

  return { parsed: undefined, errorCandidate: working, lastError };
}

function parseTrailingJson(lines) {
  let lastError;
  let errorCandidate = '';

  // Walk upward ignoring trailing noise until we accumulate a full JSON block (covers compact and pretty output).
  for (let tailIndex = lines.length - 1; tailIndex >= 0; tailIndex -= 1) {
    const attempt = tryParseJsonCandidate(lines, tailIndex);
    if (attempt.parsed) {
      return attempt.parsed;
    }
    lastError = attempt.lastError;
    errorCandidate = attempt.errorCandidate;
  }

  throw new Error(
    [
      'Failed to parse trailing JSON payload.',
      'Payload:',
      errorCandidate.length > 0 ? errorCandidate : '(no viable JSON candidate found)',
      lastError instanceof Error ? lastError.message : String(lastError),
    ].join('\n'),
  );
}

async function main() {
  const [targetPath, expectedEvent] = process.argv.slice(2);
  if (!targetPath) {
    printUsageAndExit();
  }

  const absolutePath = path.resolve(process.cwd(), targetPath);
  let raw = '';
  try {
    raw = await readLogFile(absolutePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const lines = getNonEmptyLines(raw);

  if (lines.length === 0) {
    console.error(
      `No non-empty lines found in log file at ${absolutePath}. Expected structured JSON output.`,
    );
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseTrailingJson(lines);
  } catch (error) {
    console.error(`Failed to parse trailing JSON payload in ${absolutePath}.`);
    console.error(error instanceof Error ? error.message : String(error));
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
