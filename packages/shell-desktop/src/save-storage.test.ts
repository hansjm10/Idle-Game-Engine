import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/mock/userData';
      throw new Error(`Unexpected getPath call: ${name}`);
    }),
  },
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

vi.mock('node:fs', () => {
  const actual = {
    promises: {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      readFile: vi.fn(async () => Buffer.from([])),
      readdir: vi.fn(async () => []),
    },
  };
  return actual;
});

const CANONICAL_SAVE_PATH = path.join('/mock/userData', 'idle-engine-save.bin');
const TEMP_PREFIX = '.tmp-idle-engine-save.bin-';
const EXPECTED_TEMP_PATH = path.join('/mock/userData', `${TEMP_PREFIX}test-uuid-1234`);

describe('save-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSaveFilePath', () => {
    it('returns canonical path under userData', async () => {
      const { getSaveFilePath } = await import('./save-storage.js');
      expect(getSaveFilePath()).toBe(CANONICAL_SAVE_PATH);
    });
  });

  describe('writeSave', () => {
    it('writes atomically via temp file and rename', async () => {
      const { writeSave } = await import('./save-storage.js');
      const data = new Uint8Array([1, 2, 3, 4]);

      await writeSave(data);

      expect(fsPromises.mkdir).toHaveBeenCalledWith('/mock/userData', { recursive: true });
      expect(fsPromises.writeFile).toHaveBeenCalledWith(EXPECTED_TEMP_PATH, data);
      expect(fsPromises.rename).toHaveBeenCalledWith(EXPECTED_TEMP_PATH, CANONICAL_SAVE_PATH);
    });

    it('cleans up temp file on writeFile failure', async () => {
      const { writeSave } = await import('./save-storage.js');
      const writeError = new Error('disk full');

      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(writeError);

      await expect(writeSave(new Uint8Array([1]))).rejects.toThrow('disk full');

      // Best-effort unlink of temp file
      expect(fsPromises.unlink).toHaveBeenCalledWith(EXPECTED_TEMP_PATH);
      // rename should NOT have been called
      expect(fsPromises.rename).not.toHaveBeenCalled();
    });

    it('cleans up temp file on rename failure', async () => {
      const { writeSave } = await import('./save-storage.js');
      const renameError = new Error('rename failed');

      vi.mocked(fsPromises.rename).mockRejectedValueOnce(renameError);

      await expect(writeSave(new Uint8Array([1]))).rejects.toThrow('rename failed');

      // Best-effort unlink of temp file
      expect(fsPromises.unlink).toHaveBeenCalledWith(EXPECTED_TEMP_PATH);
    });

    it('preserves previously committed save on failure', async () => {
      const { writeSave } = await import('./save-storage.js');

      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('write failed'));

      await expect(writeSave(new Uint8Array([1]))).rejects.toThrow('write failed');

      // The committed save file should never be touched on failure
      // (no unlink of the canonical path, only temp file cleanup)
      const unlinkCalls = vi.mocked(fsPromises.unlink).mock.calls;
      for (const [unlinkPath] of unlinkCalls) {
        expect(unlinkPath).not.toBe(CANONICAL_SAVE_PATH);
      }
    });

    it('swallows temp cleanup errors during failure path', async () => {
      const { writeSave } = await import('./save-storage.js');

      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('write failed'));
      vi.mocked(fsPromises.unlink).mockRejectedValueOnce(new Error('unlink also failed'));

      // Should still throw the original error, not the cleanup error
      await expect(writeSave(new Uint8Array([1]))).rejects.toThrow('write failed');
    });
  });

  describe('readSave', () => {
    it('returns bytes when save file exists', async () => {
      const { readSave } = await import('./save-storage.js');
      const content = Buffer.from([10, 20, 30]);
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(content);

      const result = await readSave();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(new Uint8Array([10, 20, 30]));
      expect(fsPromises.readFile).toHaveBeenCalledWith(CANONICAL_SAVE_PATH);
    });

    it('returns undefined when save file does not exist', async () => {
      const { readSave } = await import('./save-storage.js');
      const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readFile).mockRejectedValueOnce(enoent);

      const result = await readSave();
      expect(result).toBeUndefined();
    });

    it('rethrows non-ENOENT read errors', async () => {
      const { readSave } = await import('./save-storage.js');
      const permError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fsPromises.readFile).mockRejectedValueOnce(permError);

      await expect(readSave()).rejects.toThrow('permission denied');
    });
  });

  describe('cleanupStaleTempFiles', () => {
    it('removes files matching temp prefix', async () => {
      const { cleanupStaleTempFiles } = await import('./save-storage.js');
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        'idle-engine-save.bin',
        `${TEMP_PREFIX}abc-123`,
        `${TEMP_PREFIX}def-456`,
        'unrelated-file.txt',
      ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);

      await cleanupStaleTempFiles();

      expect(fsPromises.unlink).toHaveBeenCalledTimes(2);
      expect(fsPromises.unlink).toHaveBeenCalledWith(
        path.join('/mock/userData', `${TEMP_PREFIX}abc-123`),
      );
      expect(fsPromises.unlink).toHaveBeenCalledWith(
        path.join('/mock/userData', `${TEMP_PREFIX}def-456`),
      );
    });

    it('does not remove the committed save file', async () => {
      const { cleanupStaleTempFiles } = await import('./save-storage.js');
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        'idle-engine-save.bin',
      ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);

      await cleanupStaleTempFiles();

      expect(fsPromises.unlink).not.toHaveBeenCalled();
    });

    it('does nothing when directory does not exist', async () => {
      const { cleanupStaleTempFiles } = await import('./save-storage.js');
      vi.mocked(fsPromises.readdir).mockRejectedValueOnce(
        Object.assign(new Error('no dir'), { code: 'ENOENT' }),
      );

      // Should not throw
      await cleanupStaleTempFiles();
      expect(fsPromises.unlink).not.toHaveBeenCalled();
    });

    it('swallows unlink errors during cleanup', async () => {
      const { cleanupStaleTempFiles } = await import('./save-storage.js');
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        `${TEMP_PREFIX}stale-1`,
      ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
      vi.mocked(fsPromises.unlink).mockRejectedValueOnce(new Error('permission denied'));

      // Should not throw
      await cleanupStaleTempFiles();
    });
  });
});
