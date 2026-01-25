import type {
  AssetId,
  ImageDraw,
  RectDraw,
  RenderCommandBuffer,
  RenderDraw,
  RenderPass,
  RenderPassId,
  SortKey,
  SpriteInstance,
  TextDraw,
  UiMeterNode,
  UiNode,
  ViewModel,
} from './types.js';

export const WORLD_FIXED_POINT_SCALE = 256 as const;

export type CompileViewModelToRenderCommandBufferOptions = Readonly<{
  worldFixedPointScale?: number;
}>;

type DrawEntry = Readonly<{
  passId: RenderPassId;
  sortKey: SortKey;
  drawKey: string;
  draw: RenderDraw;
}>;

function compareNumbers(a: number, b: number): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareSortKey(a: SortKey, b: SortKey): number {
  const hi = compareNumbers(a.sortKeyHi, b.sortKeyHi);
  if (hi !== 0) {
    return hi;
  }
  return compareNumbers(a.sortKeyLo, b.sortKeyLo);
}

function requireFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Render compiler expected ${label} to be a finite number.`);
  }
  return value;
}

function roundAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return Math.ceil(value - 0.5);
  }
  return Math.floor(value + 0.5);
}

function quantizeToInt(value: number, scale: number, label: string): number {
  const finite = requireFiniteNumber(value, label);
  const scaled = finite * scale;
  if (!Number.isFinite(scaled)) {
    throw new TypeError(`Render compiler expected ${label} to be within quantizable range.`);
  }
  const quantized = roundAwayFromZero(scaled);
  return quantized === 0 ? 0 : quantized;
}

function requireInt32(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Render compiler expected ${label} to be an integer.`);
  }
  if (value < -2147483648 || value > 2147483647) {
    throw new TypeError(`Render compiler expected ${label} to fit in int32.`);
  }
  return value;
}

function encodeSignedInt32ToSortableUint32(value: number, label: string): number {
  const int32 = requireInt32(value, label);
  return (int32 ^ 0x80000000) >>> 0;
}

function requireNonEmptyString(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Render compiler expected ${label} to be a non-empty string.`);
  }
  return value;
}

function createPasses(): readonly RenderPass[] {
  return [{ id: 'world' }, { id: 'ui' }];
}

function getPassIndex(passId: RenderPassId): number {
  return passId === 'world' ? 0 : 1;
}

function sortDrawEntries(entries: DrawEntry[]): void {
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (seenKeys.has(entry.drawKey)) {
      throw new Error(`Render compiler produced duplicate drawKey: ${entry.drawKey}`);
    }
    seenKeys.add(entry.drawKey);
  }

  entries.sort((a, b) => {
    const pass = compareNumbers(getPassIndex(a.passId), getPassIndex(b.passId));
    if (pass !== 0) {
      return pass;
    }

    const sortKey = compareSortKey(a.sortKey, b.sortKey);
    if (sortKey !== 0) {
      return sortKey;
    }

    return compareStrings(a.drawKey, b.drawKey);
  });
}

function compileSpriteInstance(
  sprite: SpriteInstance,
  options: { readonly worldFixedPointScale: number },
): DrawEntry {
  const id = requireNonEmptyString(sprite.id, 'SpriteInstance.id');
  const assetId = requireNonEmptyString(sprite.assetId, 'SpriteInstance.assetId') as AssetId;

  const x = quantizeToInt(sprite.x, options.worldFixedPointScale, `SpriteInstance(${id}).x`);
  const y = quantizeToInt(sprite.y, options.worldFixedPointScale, `SpriteInstance(${id}).y`);
  const width = quantizeToInt(
    sprite.width,
    options.worldFixedPointScale,
    `SpriteInstance(${id}).width`,
  );
  const height = quantizeToInt(
    sprite.height,
    options.worldFixedPointScale,
    `SpriteInstance(${id}).height`,
  );
  const z = quantizeToInt(sprite.z, options.worldFixedPointScale, `SpriteInstance(${id}).z`);

  const sortKey: SortKey = {
    sortKeyHi: encodeSignedInt32ToSortableUint32(z, `SpriteInstance(${id}).sortKeyHi`),
    sortKeyLo: encodeSignedInt32ToSortableUint32(y, `SpriteInstance(${id}).sortKeyLo`),
  };

  const draw: ImageDraw = {
    kind: 'image',
    passId: 'world',
    sortKey,
    assetId,
    x,
    y,
    width,
    height,
    tintRgba: sprite.tintRgba,
  };

  return {
    passId: 'world',
    sortKey,
    drawKey: `world:sprite:${id}`,
    draw,
  };
}

function compileUiNode(node: UiNode): readonly DrawEntry[] {
  const id = requireNonEmptyString(node.id, 'UiNode.id');

  const x = quantizeToInt(node.x, 1, `UiNode(${id}).x`);
  const y = quantizeToInt(node.y, 1, `UiNode(${id}).y`);
  const width = quantizeToInt(node.width, 1, `UiNode(${id}).width`);
  const height = quantizeToInt(node.height, 1, `UiNode(${id}).height`);

  const sortKey: SortKey = {
    sortKeyHi: encodeSignedInt32ToSortableUint32(y, `UiNode(${id}).sortKeyHi`),
    sortKeyLo: encodeSignedInt32ToSortableUint32(x, `UiNode(${id}).sortKeyLo`),
  };

  switch (node.kind) {
    case 'rect': {
      const draw: RectDraw = {
        kind: 'rect',
        passId: 'ui',
        sortKey,
        x,
        y,
        width,
        height,
        colorRgba: node.colorRgba,
      };

      return [
        {
          passId: 'ui',
          sortKey,
          drawKey: `ui:rect:${id}`,
          draw,
        },
      ];
    }
    case 'image': {
      const assetId = requireNonEmptyString(node.assetId, `UiImageNode(${id}).assetId`) as AssetId;
      const draw: ImageDraw = {
        kind: 'image',
        passId: 'ui',
        sortKey,
        assetId,
        x,
        y,
        width,
        height,
        tintRgba: node.tintRgba,
      };

      return [
        {
          passId: 'ui',
          sortKey,
          drawKey: `ui:image:${id}`,
          draw,
        },
      ];
    }
    case 'text': {
      const fontSizePx = quantizeToInt(node.fontSizePx, 1, `UiTextNode(${id}).fontSizePx`);
      const draw: TextDraw = {
        kind: 'text',
        passId: 'ui',
        sortKey,
        x,
        y,
        text: node.text,
        colorRgba: node.colorRgba,
        fontAssetId: node.fontAssetId,
        fontSizePx,
      };

      return [
        {
          passId: 'ui',
          sortKey,
          drawKey: `ui:text:${id}`,
          draw,
        },
      ];
    }
    case 'meter':
      return compileUiMeterNode(node, { id, x, y, width, height, sortKey });
  }
}

function compileUiMeterNode(
  node: UiMeterNode,
  options: { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly sortKey: SortKey },
): readonly DrawEntry[] {
  const value = requireFiniteNumber(node.value, `UiMeterNode(${options.id}).value`);
  const max = requireFiniteNumber(node.max, `UiMeterNode(${options.id}).max`);

  const clampedMax = Math.max(0, max);
  const clampedValue = clampedMax > 0 ? Math.max(0, Math.min(value, clampedMax)) : 0;
  const fillWidth =
    clampedMax === 0 ? 0 : Math.max(0, Math.min(options.width, Math.floor((options.width * clampedValue) / clampedMax)));

  const backgroundDraw: RectDraw = {
    kind: 'rect',
    passId: 'ui',
    sortKey: options.sortKey,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    colorRgba: node.backgroundColorRgba,
  };

  const fillDraw: RectDraw = {
    kind: 'rect',
    passId: 'ui',
    sortKey: options.sortKey,
    x: options.x,
    y: options.y,
    width: fillWidth,
    height: options.height,
    colorRgba: node.fillColorRgba,
  };

  return [
    {
      passId: 'ui',
      sortKey: options.sortKey,
      drawKey: `ui:meter:${options.id}:background`,
      draw: backgroundDraw,
    },
    {
      passId: 'ui',
      sortKey: options.sortKey,
      drawKey: `ui:meter:${options.id}:fill`,
      draw: fillDraw,
    },
  ];
}

export function compileViewModelToRenderCommandBuffer(
  viewModel: ViewModel,
  options: CompileViewModelToRenderCommandBufferOptions = {},
): RenderCommandBuffer {
  const worldFixedPointScale = options.worldFixedPointScale ?? WORLD_FIXED_POINT_SCALE;
  if (!Number.isFinite(worldFixedPointScale) || worldFixedPointScale <= 0) {
    throw new Error('Render compiler expected worldFixedPointScale to be a positive number.');
  }

  const cameraX = requireFiniteNumber(viewModel.scene.camera.x, 'ViewModel.scene.camera.x');
  const cameraY = requireFiniteNumber(viewModel.scene.camera.y, 'ViewModel.scene.camera.y');
  const cameraZoom = requireFiniteNumber(
    viewModel.scene.camera.zoom,
    'ViewModel.scene.camera.zoom',
  );
  if (cameraZoom <= 0) {
    throw new Error('Render compiler expected ViewModel.scene.camera.zoom to be positive.');
  }

  const passes = createPasses();
  const entries: DrawEntry[] = [];

  for (const sprite of viewModel.scene.sprites) {
    entries.push(compileSpriteInstance(sprite, { worldFixedPointScale }));
  }

  for (const node of viewModel.ui.nodes) {
    entries.push(...compileUiNode(node));
  }

  sortDrawEntries(entries);

  const draws: RenderDraw[] = [];
  for (const entry of entries) {
    draws.push(entry.draw);
  }

  return {
    frame: {
      schemaVersion: viewModel.frame.schemaVersion,
      step: viewModel.frame.step,
      simTimeMs: viewModel.frame.simTimeMs,
      contentHash: viewModel.frame.contentHash,
      renderFrame: viewModel.frame.renderFrame,
    },
    scene: {
      camera: {
        x: cameraX,
        y: cameraY,
        zoom: cameraZoom,
      },
    },
    passes,
    draws,
  };
}

export const __test__ = {
  quantizeToInt,
  encodeSignedInt32ToSortableUint32,
};
