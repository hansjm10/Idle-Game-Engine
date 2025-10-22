import type { CompileOptions, WorkspaceFS } from '../types.js';

export interface CompilerContext {
  readonly fs: WorkspaceFS;
  readonly options: CompileOptions;
}

export function createCompilerContext(
  fs: WorkspaceFS,
  options: CompileOptions,
): CompilerContext {
  return {
    fs,
    options,
  };
}
