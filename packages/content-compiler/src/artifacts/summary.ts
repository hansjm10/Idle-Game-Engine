import type { WorkspaceCompileResult, WorkspaceSummary } from '../types.js';

export function createWorkspaceSummary(
  result: WorkspaceCompileResult,
  timestamp: string,
): WorkspaceSummary {
  return {
    packs: result.packs,
    generatedAt: timestamp,
  };
}
