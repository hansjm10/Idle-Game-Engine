import { promises as fsPromises } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';

const SAVE_FILENAME = 'idle-engine-save.bin';
const TEMP_PREFIX = `.tmp-${SAVE_FILENAME}-`;

/**
 * Returns the canonical save file path under the Electron userData directory.
 */
export function getSaveFilePath(): string {
  return path.join(app.getPath('userData'), SAVE_FILENAME);
}

/**
 * Writes save data atomically to the canonical save path.
 *
 * Uses a temp file in the same directory followed by rename so that
 * a crash or power loss never leaves a partially-written committed save.
 * On failure the previously committed save is preserved and best-effort
 * cleanup of the temp file is attempted.
 */
export async function writeSave(data: Uint8Array): Promise<void> {
  const saveDir = path.dirname(getSaveFilePath());
  const tempPath = path.join(saveDir, `${TEMP_PREFIX}${randomUUID()}`);

  try {
    await fsPromises.mkdir(saveDir, { recursive: true });
    await fsPromises.writeFile(tempPath, data);
    await fsPromises.rename(tempPath, getSaveFilePath());
  } catch (error) {
    // Best-effort cleanup of temp file; swallow errors
    await safeUnlink(tempPath);
    throw error;
  }

  // After successful rename the temp path no longer exists on most
  // platforms, but clean up defensively in case rename semantics differ.
  await safeUnlink(tempPath);
}

/**
 * Reads the committed save file bytes, or returns `undefined` if the
 * save file does not exist.
 */
export async function readSave(): Promise<Uint8Array | undefined> {
  try {
    const buffer = await fsPromises.readFile(getSaveFilePath());
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Removes stale temp files left by interrupted save operations.
 *
 * Scans the userData directory for files whose basename starts with the
 * canonical temp prefix (`.tmp-idle-engine-save.bin-`) and deletes them.
 */
export async function cleanupStaleTempFiles(): Promise<void> {
  const saveDir = path.dirname(getSaveFilePath());
  let entries: string[];
  try {
    entries = await fsPromises.readdir(saveDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory may not exist on first launch; nothing to clean up.
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.startsWith(TEMP_PREFIX)) {
      await safeUnlink(path.join(saveDir, entry));
    }
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await fsPromises.unlink(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    // Best-effort: swallow all errors during cleanup
  }
}
