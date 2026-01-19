import type {
  AssetId,
  ImageDraw,
  RenderCommandBuffer,
  RenderDraw,
  RenderPassId,
  SortKey,
} from '@idle-engine/renderer-contract';

export interface OrderedDraw {
  readonly draw: RenderDraw;
  readonly originalIndex: number;
  readonly passId: RenderPassId;
  readonly passIndex: number;
  readonly sortKey: SortKey;
}

export interface SpriteUvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface SpriteInstanceGroup {
  readonly passId: RenderPassId;
  readonly firstInstance: number;
  readonly instanceCount: number;
}

export interface SpriteInstanceBuildResult {
  readonly instances: Float32Array;
  readonly groups: readonly SpriteInstanceGroup[];
  readonly instanceCount: number;
}

function compareNumbers(a: number, b: number): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function compareSortKey(a: SortKey, b: SortKey): number {
  const hi = compareNumbers(a.sortKeyHi, b.sortKeyHi);
  if (hi !== 0) {
    return hi;
  }
  return compareNumbers(a.sortKeyLo, b.sortKeyLo);
}

export function orderDrawsByPassAndSortKey(rcb: RenderCommandBuffer): readonly OrderedDraw[] {
  const passIndexById = new Map<RenderPassId, number>();
  for (let index = 0; index < rcb.passes.length; index += 1) {
    const pass = rcb.passes[index];
    if (pass && !passIndexById.has(pass.id)) {
      passIndexById.set(pass.id, index);
    }
  }

  const ordered: OrderedDraw[] = [];
  for (let index = 0; index < rcb.draws.length; index += 1) {
    const draw = rcb.draws[index];
    if (draw.kind === 'clear') {
      continue;
    }

    ordered.push({
      draw,
      originalIndex: index,
      passId: draw.passId,
      passIndex: passIndexById.get(draw.passId) ?? Number.MAX_SAFE_INTEGER,
      sortKey: draw.sortKey,
    });
  }

  ordered.sort((a, b) => {
    const pass = compareNumbers(a.passIndex, b.passIndex);
    if (pass !== 0) {
      return pass;
    }

    const sortKey = compareSortKey(a.sortKey, b.sortKey);
    if (sortKey !== 0) {
      return sortKey;
    }

    return compareNumbers(a.originalIndex, b.originalIndex);
  });

  return ordered;
}

const FLOATS_PER_SPRITE_INSTANCE = 12;

export function buildSpriteInstances(options: {
  readonly orderedDraws: readonly OrderedDraw[];
  readonly uvByAssetId: ReadonlyMap<AssetId, SpriteUvRect>;
}): SpriteInstanceBuildResult {
  const imageDraws: Array<{ passId: RenderPassId; draw: ImageDraw }> = [];

  for (const entry of options.orderedDraws) {
    if (entry.draw.kind === 'image') {
      imageDraws.push({ passId: entry.passId, draw: entry.draw });
    }
  }

  const instances = new Float32Array(imageDraws.length * FLOATS_PER_SPRITE_INSTANCE);
  const groups: SpriteInstanceGroup[] = [];

  let writeOffset = 0;
  let currentGroupPass: RenderPassId | undefined;
  let currentGroupFirstInstance = 0;

  function pushGroup(endInstance: number): void {
    if (currentGroupPass === undefined) {
      return;
    }
    const instanceCount = endInstance - currentGroupFirstInstance;
    if (instanceCount <= 0) {
      return;
    }
    groups.push({
      passId: currentGroupPass,
      firstInstance: currentGroupFirstInstance,
      instanceCount,
    });
  }

  for (let index = 0; index < imageDraws.length; index += 1) {
    const imageDraw = imageDraws[index];
    if (!imageDraw) {
      continue;
    }

    if (currentGroupPass === undefined) {
      currentGroupPass = imageDraw.passId;
      currentGroupFirstInstance = index;
    } else if (currentGroupPass !== imageDraw.passId) {
      pushGroup(index);
      currentGroupPass = imageDraw.passId;
      currentGroupFirstInstance = index;
    }

    const uv = options.uvByAssetId.get(imageDraw.draw.assetId);
    if (!uv) {
      throw new Error(`Atlas missing UVs for AssetId: ${imageDraw.draw.assetId}`);
    }

    const tintRgba = imageDraw.draw.tintRgba;
    const tintAlpha = tintRgba === undefined ? 1 : ((tintRgba >>> 0) & 0xff) / 255;

    instances[writeOffset++] = imageDraw.draw.x;
    instances[writeOffset++] = imageDraw.draw.y;
    instances[writeOffset++] = imageDraw.draw.width;
    instances[writeOffset++] = imageDraw.draw.height;
    instances[writeOffset++] = uv.u0;
    instances[writeOffset++] = uv.v0;
    instances[writeOffset++] = uv.u1;
    instances[writeOffset++] = uv.v1;
    instances[writeOffset++] = 1;
    instances[writeOffset++] = 1;
    instances[writeOffset++] = 1;
    instances[writeOffset++] = tintAlpha;
  }

  pushGroup(imageDraws.length);

  return {
    instances,
    groups,
    instanceCount: imageDraws.length,
  };
}

export const __test__ = {
  compareSortKey,
  FLOATS_PER_SPRITE_INSTANCE,
};
