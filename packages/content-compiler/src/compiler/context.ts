import type {
  CompileOptions,
  SchemaContextInput,
  WorkspaceFS,
} from '../types.js';

export interface CompilerContext {
  readonly fs: WorkspaceFS;
  readonly options: CompileOptions;
  readonly schemaOptions: SchemaContextInput;
}

function createSchemaOptions(
  input: SchemaContextInput | undefined,
): SchemaContextInput {
  if (input === undefined) {
    return {};
  }

  return {
    ...(input.runtimeEventCatalogue !== undefined
      ? { runtimeEventCatalogue: input.runtimeEventCatalogue }
      : {}),
    ...(input.knownPacks !== undefined ? { knownPacks: input.knownPacks } : {}),
    ...(input.activePackIds !== undefined ? { activePackIds: input.activePackIds } : {}),
  };
}

export function createCompilerContext(
  fs: WorkspaceFS,
  options: CompileOptions,
): CompilerContext {
  return {
    fs,
    options,
    schemaOptions: createSchemaOptions(options.schema),
  };
}
