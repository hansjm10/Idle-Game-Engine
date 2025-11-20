import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const cliPath = path.resolve(packageRoot, 'src', 'index.ts');
const snapshotPath = path.resolve(packageRoot, '__fixtures__', 'snapshot.json');
const definitionsPath = path.resolve(packageRoot, '__fixtures__', 'definitions.json');

describe('economy verification CLI', () => {
  it('emits deterministic JSON for the fixture snapshot', async () => {
    const ticks = 40;
    const { stdout } = await execFileAsync(
      'node',
      [
        '--import',
        'tsx',
        cliPath,
        '--snapshot',
        snapshotPath,
        '--definitions',
        definitionsPath,
        '--ticks',
        String(ticks),
      ],
      { cwd: repoRoot },
    );

    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);

    const payload = JSON.parse(lines[0]);
    expect(payload.event).toBe('economy_verification');
    expect(payload.reconciliation.digestsMatch).toBe(true);
    expect(payload.ticks).toBe(ticks);
    expect(payload.offlineMs).toBe(ticks * payload.stepSizeMs);

    const gems = payload.result.deltas.find(
      (delta: any) => delta.id === 'gems',
    );
    const shards = payload.result.deltas.find(
      (delta: any) => delta.id === 'shards',
    );

    expect(gems?.delta).toBeCloseTo(9, 6);
    expect(gems?.endAmount).toBeCloseTo(19, 6);
    expect(shards?.delta).toBeCloseTo(-2.5, 6);
    expect(shards?.endAmount).toBeCloseTo(2.5, 6);
  });

  it('derives ticks from offline-ms when omitted', async () => {
    const offlineMs = 120;
    const { stdout } = await execFileAsync(
      'node',
      [
        '--import',
        'tsx',
        cliPath,
        '--snapshot',
        snapshotPath,
        '--definitions',
        definitionsPath,
        '--offline-ms',
        String(offlineMs),
      ],
      { cwd: repoRoot },
    );

    const payload = JSON.parse(stdout.trim());
    const expectedTicks = Math.floor(offlineMs / payload.stepSizeMs);

    expect(payload.ticks).toBe(expectedTicks);
    expect(payload.offlineMs).toBe(expectedTicks * payload.stepSizeMs);
    expect(payload.result.deltas.length).toBeGreaterThan(0);
  });
});
