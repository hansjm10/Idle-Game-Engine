import { z } from 'zod';

import type { ContentSchemaWarning } from '../../errors.js';
import type { NormalizedAllowlistSpec } from '../types.js';
import { toMutablePath } from '../utils.js';

export const assertAllowlisted = (
  spec: NormalizedAllowlistSpec | undefined,
  id: string,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  warningSink: (warning: ContentSchemaWarning) => void,
  warningCode: string,
  message: string,
) => {
  if (!spec) {
    return;
  }

  if (spec.required.has(id) || spec.soft.has(id)) {
    return;
  }

  if (spec.soft.size > 0 && !spec.required.size) {
    warningSink({
      code: warningCode,
      message,
      path: toMutablePath(path),
      severity: 'warning',
    });
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: toMutablePath(path),
    message,
  });
};

