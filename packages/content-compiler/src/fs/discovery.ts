import type { ContentDocument, WorkspaceFS } from '../types.js';

export async function discoverContentDocuments(
  fs: WorkspaceFS,
): Promise<readonly ContentDocument[]> {
  void fs;
  return [];
}
