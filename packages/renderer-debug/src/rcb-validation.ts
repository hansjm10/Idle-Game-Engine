import type {
  ClearDraw,
  ImageDraw,
  RectDraw,
  RenderCommandBuffer,
  RenderPassId,
  SortKey,
  TextDraw,
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

function sortKeyToString(sortKey: SortKey): string {
  return `${sortKey.sortKeyHi}:${sortKey.sortKeyLo}`;
}

function compareSortKey(a: SortKey, b: SortKey): number {
  if (a.sortKeyHi !== b.sortKeyHi) {
    return a.sortKeyHi - b.sortKeyHi;
  }
  return a.sortKeyLo - b.sortKeyLo;
}

function validateDrawCommon(
  errors: string[],
  path: string,
  draw: { readonly passId: RenderPassId; readonly sortKey: SortKey },
  passIndexById: ReadonlyMap<RenderPassId, number>,
): void {
  if (!passIndexById.has(draw.passId)) {
    errors.push(`${path}.passId references unknown passId: ${draw.passId}`);
  }

  if (!isUint32(draw.sortKey.sortKeyHi)) {
    errors.push(`${path}.sortKey.sortKeyHi must be uint32`);
  }
  if (!isUint32(draw.sortKey.sortKeyLo)) {
    errors.push(`${path}.sortKey.sortKeyLo must be uint32`);
  }
}

function validateClearDraw(
  errors: string[],
  path: string,
  draw: ClearDraw,
  passIndexById: ReadonlyMap<RenderPassId, number>,
): void {
  validateDrawCommon(errors, path, draw, passIndexById);
  if (!isUint32(draw.colorRgba)) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }
}

function validateRectDraw(
  errors: string[],
  path: string,
  draw: RectDraw,
  passIndexById: ReadonlyMap<RenderPassId, number>,
): void {
  validateDrawCommon(errors, path, draw, passIndexById);

  if (!isFiniteNumber(draw.x)) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw.y)) {
    errors.push(`${path}.y must be a finite number`);
  }
  if (!isFiniteNumber(draw.width) || draw.width < 0) {
    errors.push(`${path}.width must be a finite non-negative number`);
  }
  if (!isFiniteNumber(draw.height) || draw.height < 0) {
    errors.push(`${path}.height must be a finite non-negative number`);
  }
  if (!isUint32(draw.colorRgba)) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }
}

function validateImageDraw(
  errors: string[],
  path: string,
  draw: ImageDraw,
  passIndexById: ReadonlyMap<RenderPassId, number>,
): void {
  validateDrawCommon(errors, path, draw, passIndexById);

  if (draw.assetId.length === 0) {
    errors.push(`${path}.assetId must be non-empty`);
  }
  if (!isFiniteNumber(draw.x)) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw.y)) {
    errors.push(`${path}.y must be a finite number`);
  }
  if (!isFiniteNumber(draw.width) || draw.width < 0) {
    errors.push(`${path}.width must be a finite non-negative number`);
  }
  if (!isFiniteNumber(draw.height) || draw.height < 0) {
    errors.push(`${path}.height must be a finite non-negative number`);
  }
  if (draw.tintRgba !== undefined && !isUint32(draw.tintRgba)) {
    errors.push(`${path}.tintRgba must be uint32 RGBA when provided`);
  }
}

function validateTextDraw(
  errors: string[],
  path: string,
  draw: TextDraw,
  passIndexById: ReadonlyMap<RenderPassId, number>,
): void {
  validateDrawCommon(errors, path, draw, passIndexById);

  if (!isFiniteNumber(draw.x)) {
    errors.push(`${path}.x must be a finite number`);
  }
  if (!isFiniteNumber(draw.y)) {
    errors.push(`${path}.y must be a finite number`);
  }
  if (!isUint32(draw.colorRgba)) {
    errors.push(`${path}.colorRgba must be uint32 RGBA`);
  }
  if (draw.fontAssetId !== undefined && draw.fontAssetId.length === 0) {
    errors.push(`${path}.fontAssetId must be non-empty when provided`);
  }
  if (!isFiniteNumber(draw.fontSizePx) || draw.fontSizePx <= 0) {
    errors.push(`${path}.fontSizePx must be a finite positive number`);
  }
}

export function validateRenderCommandBuffer(
  rcb: RenderCommandBuffer,
): RenderCommandBufferValidationResult {
  const errors: string[] = [];

  const passIndexById = new Map<RenderPassId, number>();
  for (let index = 0; index < rcb.passes.length; index++) {
    const pass = rcb.passes[index];
    if (passIndexById.has(pass.id)) {
      errors.push(`passes contains duplicate id: ${pass.id}`);
      continue;
    }
    passIndexById.set(pass.id, index);
  }

  for (let index = 0; index < rcb.draws.length; index++) {
    const draw = rcb.draws[index];
    const path = `draws[${index}]`;

    switch (draw.kind) {
      case 'clear':
        validateClearDraw(errors, path, draw, passIndexById);
        break;
      case 'rect':
        validateRectDraw(errors, path, draw, passIndexById);
        break;
      case 'image':
        validateImageDraw(errors, path, draw, passIndexById);
        break;
      case 'text':
        validateTextDraw(errors, path, draw, passIndexById);
        break;
      default: {
        const exhaustiveCheck: never = draw;
        errors.push(
          `${path} has unsupported kind: ${String(exhaustiveCheck)}`,
        );
      }
    }
  }

  let previousPassIndex = -1;
  let previousSortKey: SortKey | undefined;

  for (let index = 0; index < rcb.draws.length; index++) {
    const draw = rcb.draws[index];
    const passIndex = passIndexById.get(draw.passId);
    if (passIndex === undefined) {
      previousPassIndex = -1;
      previousSortKey = undefined;
      continue;
    }

    if (passIndex < previousPassIndex) {
      errors.push(
        `draws[${index}] passId ${draw.passId} out of order (pass index ${passIndex} < ${previousPassIndex})`,
      );
      previousPassIndex = passIndex;
      previousSortKey = draw.sortKey;
      continue;
    }

    if (passIndex === previousPassIndex && previousSortKey) {
      if (compareSortKey(draw.sortKey, previousSortKey) < 0) {
        errors.push(
          `draws[${index}] sortKey out of order (${sortKeyToString(draw.sortKey)} < ${sortKeyToString(previousSortKey)})`,
        );
      }
    }

    previousPassIndex = passIndex;
    previousSortKey = draw.sortKey;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}
