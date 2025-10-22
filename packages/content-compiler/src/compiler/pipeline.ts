import { createCompilerContext, type CompilerContext } from './context.js';
import type {
  CompileOptions,
  CompileWorkspaceOptions,
  ContentDocument,
  PackArtifactResult,
  WorkspaceCompileResult,
  WorkspaceFS,
} from '../types.js';

export async function compileContentPack(
  document: ContentDocument,
  options: CompileOptions,
): Promise<PackArtifactResult> {
  createCompilerContext({ rootDirectory: options.cwd ?? '' }, options);
  return {
    packSlug: document.packSlug,
    artifacts: [],
    warnings: [],
  };
}

export async function compileWorkspacePacks(
  fs: WorkspaceFS,
  options: CompileWorkspaceOptions,
): Promise<WorkspaceCompileResult> {
  const context: CompilerContext = createCompilerContext(fs, options);
  void context;
  return {
    packs: [],
    summaryPath: options.summaryOutputPath,
  };
}
