import { z } from 'zod';

export class ContentSchemaError extends Error {
  constructor(message = 'Content schema validation failed') {
    super(message);
    this.name = 'ContentSchemaError';
  }
}

export type ContentSchemaWarningSeverity = 'error' | 'warning' | 'info';

export interface ContentSchemaWarning {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly severity: ContentSchemaWarningSeverity;
  readonly suggestion?: string;
  readonly issues?: readonly z.ZodIssue[];
}
