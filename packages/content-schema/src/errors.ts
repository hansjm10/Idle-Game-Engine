export class ContentSchemaError extends Error {
  constructor(message = 'Content schema validation failed') {
    super(message);
    this.name = 'ContentSchemaError';
  }
}

export interface ContentSchemaWarning {
  readonly message: string;
}
