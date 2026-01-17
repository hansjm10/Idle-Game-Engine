import type {
  RenderCommandBuffer,
  RenderPassId,
  SortKey,
} from '@idle-engine/renderer-contract';

export type RenderCommandBufferValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRenderPassId(value: unknown): value is RenderPassId {
  return value === 'world' || value === 'ui';
}

function sortKeyToString(sortKey: SortKey): string {
  return `${sortKey.sortKeyHi}:${sortKey.sortKeyLo}`;
}

function compareSortKey(a: SortKey, b: SortKey): number {
  if (a.sortKeyHi !== b.sortKeyHi) {
    return a.sortKeyHi - b.sortKeyHi;
  }
  return a.sortKeyLo - b.sortKeyLo;
}

function parseSortKey(
  errors: string[],
  path: string,
  sortKey: unknown,
): SortKey | undefined {
  if (!isRecord(sortKey)) {
    errors.push(`${path}.sortKey must be an object`);
    return undefined;
  }

  const sortKeyHi = sortKey['sortKeyHi'];
  const sortKeyLo = sortKey['sortKeyLo'];

  if (!isUint32(sortKeyHi)) {
    errors.push(`${path}.sortKey.sortKeyHi must be uint32`);
  }
  if (!isUint32(sortKeyLo)) {
    errors.push(`${path}.sortKey.sortKeyLo must be uint32`);
  }

  if (!isUint32(sortKeyHi) || !isUint32(sortKeyLo)) {
    return undefined;
  }

  return { sortKeyHi, sortKeyLo };
}

function parseDrawCommon(
  errors: string[],
  path: string,
  draw: Record<string, unknown>,
  passIndexById: ReadonlyMap<RenderPassId, number>,
): {
  readonly passId: RenderPassId | undefined;
  readonly passIndex: number | undefined;
  readonly sortKey: SortKey | undefined;
} {
  const passIdValue = draw['passId'];
  let passId: RenderPassId | undefined;
  let passIndex: number | undefined;

  if (!isRenderPassId(passIdValue)) {
    errors.push(`${path}.passId must be 'world' or 'ui'`);
  } else {
    passId = passIdValue;
    passIndex = passIndexById.get(passIdValue);
    if (passIndex === undefined) {
      errors.push(`${path}.passId references unknown passId: ${passIdValue}`);
    }
  }

  const sortKey = parseSortKey(errors, path, draw['sortKey']);

  return { passId, passIndex, sortKey };
}

function validateClearDraw(
  errors: string[],
  path: string,
  draw: Record<string, unknown>,
): void {
  if (!isUint32(draw['colorRgba'])) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }
}

function validateRectDraw(
  errors: string[],
  path: string,
  draw: Record<string, unknown>,
): void {
  if (!isFiniteNumber(draw['x'])) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw['y'])) {
    errors.push(`${path}.y must be a finite number`);
  }

  const width = draw['width'];
  if (!isFiniteNumber(width) || width < 0) {
    errors.push(`${path}.width must be a finite non-negative number`);
  }

  const height = draw['height'];
  if (!isFiniteNumber(height) || height < 0) {
    errors.push(`${path}.height must be a finite non-negative number`);
  }

  if (!isUint32(draw['colorRgba'])) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }
}

function validateImageDraw(
  errors: string[],
  path: string,
  draw: Record<string, unknown>,
): void {
  const assetId = draw['assetId'];
  if (typeof assetId !== 'string' || assetId.length === 0) {
    errors.push(`${path}.assetId must be non-empty`);
  }

  if (!isFiniteNumber(draw['x'])) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw['y'])) {
    errors.push(`${path}.y must be a finite number`);
  }

  const width = draw['width'];
  if (!isFiniteNumber(width) || width < 0) {
    errors.push(`${path}.width must be a finite non-negative number`);
  }

  const height = draw['height'];
  if (!isFiniteNumber(height) || height < 0) {
    errors.push(`${path}.height must be a finite non-negative number`);
  }

  const tintRgba = draw['tintRgba'];
  if (tintRgba !== undefined && !isUint32(tintRgba)) {
    errors.push(`${path}.tintRgba must be uint32 RGBA when provided`);
  }
}

function validateTextDraw(
  errors: string[],
  path: string,
  draw: Record<string, unknown>,
): void {
  if (!isFiniteNumber(draw['x'])) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw['y'])) {
    errors.push(`${path}.y must be a finite number`);
  }

  if (typeof draw['text'] !== 'string') {
    errors.push(`${path}.text must be a string`);
  }

  if (!isUint32(draw['colorRgba'])) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }

  const fontAssetId = draw['fontAssetId'];
  if (
    fontAssetId !== undefined &&
    (typeof fontAssetId !== 'string' || fontAssetId.length === 0)
  ) {
    errors.push(`${path}.fontAssetId must be non-empty when provided`);
  }

  const fontSizePx = draw['fontSizePx'];
  if (!isFiniteNumber(fontSizePx) || fontSizePx <= 0) {
    errors.push(`${path}.fontSizePx must be a finite positive number`);
  }
}

export function validateRenderCommandBuffer(
  rcb: RenderCommandBuffer,
): RenderCommandBufferValidationResult {
  const errors: string[] = [];

  const rcbValue: unknown = rcb;
  if (!isRecord(rcbValue)) {
    return { ok: false, errors: ['rcb must be an object'] };
  }

  const passesValue = rcbValue['passes'];
  const drawsValue = rcbValue['draws'];

  if (!Array.isArray(passesValue)) {
    errors.push('passes must be an array');
  }
  if (!Array.isArray(drawsValue)) {
    errors.push('draws must be an array');
  }

  const passes = Array.isArray(passesValue) ? passesValue : [];
  const draws = Array.isArray(drawsValue) ? drawsValue : [];

  const passIndexById = new Map<RenderPassId, number>();
  for (let index = 0; index < passes.length; index++) {
    const path = `passes[${index}]`;
    const pass = passes[index];
    if (!isRecord(pass)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    const id = pass['id'];
    if (!isRenderPassId(id)) {
      errors.push(`${path}.id must be 'world' or 'ui'`);
      continue;
    }

    if (passIndexById.has(id)) {
      errors.push(`passes contains duplicate id: ${id}`);
      continue;
    }

    passIndexById.set(id, index);
  }

  const drawOrderInfo: Array<{
    passId: RenderPassId | undefined;
    passIndex: number | undefined;
    sortKey: SortKey | undefined;
  }> = [];

  for (let index = 0; index < draws.length; index++) {
    const path = `draws[${index}]`;
    const draw = draws[index];

    if (!isRecord(draw)) {
      errors.push(`${path} must be an object`);
      drawOrderInfo.push({
        passId: undefined,
        passIndex: undefined,
        sortKey: undefined,
      });
      continue;
    }

    const kind = draw['kind'];
    if (typeof kind !== 'string') {
      errors.push(`${path}.kind must be a string`);
    }

    const common = parseDrawCommon(errors, path, draw, passIndexById);
    drawOrderInfo.push(common);

    switch (kind) {
      case 'clear':
        validateClearDraw(errors, path, draw);
        break;
      case 'rect':
        validateRectDraw(errors, path, draw);
        break;
      case 'image':
        validateImageDraw(errors, path, draw);
        break;
      case 'text':
        validateTextDraw(errors, path, draw);
        break;
      default:
        if (typeof kind === 'string') {
          errors.push(`${path}.kind must be one of: clear, rect, image, text`);
        }
    }
  }

  let previousPassIndex = -1;
  let previousSortKey: SortKey | undefined;

  for (let index = 0; index < drawOrderInfo.length; index++) {
    const { passId, passIndex, sortKey } = drawOrderInfo[index];
    if (passIndex === undefined) {
      previousPassIndex = -1;
      previousSortKey = undefined;
      continue;
    }

    if (passIndex < previousPassIndex) {
      errors.push(
        `draws[${index}] passId ${passId} out of order (pass index ${passIndex} < ${previousPassIndex})`,
      );
      previousPassIndex = passIndex;
      previousSortKey = sortKey;
      continue;
    }

    if (
      passIndex === previousPassIndex &&
      previousSortKey !== undefined &&
      sortKey !== undefined
    ) {
      if (compareSortKey(sortKey, previousSortKey) < 0) {
        errors.push(
          `draws[${index}] sortKey out of order (${sortKeyToString(sortKey)} < ${sortKeyToString(previousSortKey)})`,
        );
      }
    }

    previousPassIndex = passIndex;
    previousSortKey = sortKey;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
