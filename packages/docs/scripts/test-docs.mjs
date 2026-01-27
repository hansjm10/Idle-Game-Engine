import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

async function readRepoFile(relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${relativePath}: ${message}`);
  }
}

async function assertFileContains(relativePath, fragments) {
  const contents = await readRepoFile(relativePath);

  for (const fragment of fragments) {
    assert.ok(
      contents.includes(fragment),
      `Expected ${relativePath} to include:\n\n${fragment}\n`,
    );
  }
}

async function assertFileExcludes(relativePath, fragments) {
  const contents = await readRepoFile(relativePath);

  for (const fragment of fragments) {
    assert.ok(
      !contents.includes(fragment),
      `Expected ${relativePath} to not include:\n\n${fragment}\n`,
    );
  }
}

await assertFileContains('docs/shell-desktop-mcp.md', [
  'IDLE_ENGINE_ENABLE_MCP_SERVER',
  'IDLE_ENGINE_MCP_PORT',
  '--enable-mcp-server',
  '/mcp/sse',
  'Cursor',
  'Claude Desktop',
  'Regression',
  'Debugging',
  'Content iteration',
]);

await assertFileContains('packages/docs/sidebars.ts', ['shell-desktop-mcp']);

await assertFileContains('docs/issue-857-design.md', [
  'IDLE_ENGINE_ENABLE_MCP_SERVER',
  'IDLE_ENGINE_MCP_PORT',
]);

await assertFileExcludes('docs/issue-857-design.md', [
  'IDLE_ENGINE_ENABLE_MCP=',
  'IDLE_ENGINE_MCP_TRANSPORT',
]);
