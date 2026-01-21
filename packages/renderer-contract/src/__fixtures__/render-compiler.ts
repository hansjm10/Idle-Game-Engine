import { RENDERER_CONTRACT_SCHEMA_VERSION } from '../types.js';
import type { AssetId, ViewModel } from '../types.js';

export const renderCompilerFixtureViewModel: ViewModel = {
  frame: {
    schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
    step: 7,
    simTimeMs: 112,
    contentHash: 'content:fixture',
  },
  scene: {
    camera: { x: 0.25, y: -1.125, zoom: 1 },
    sprites: [
      {
        id: 'sprite-b',
        assetId: 'asset:sprite-b' as AssetId,
        x: 1.1,
        y: -2.03,
        z: 0,
        width: 3.333,
        height: 4.666,
        tintRgba: 0x22_44_66_ff,
      },
      {
        id: 'sprite-a',
        assetId: 'asset:sprite-a' as AssetId,
        x: -0.5,
        y: 0,
        z: 0,
        width: 1.5,
        height: 2,
      },
    ],
  },
  ui: {
    nodes: [
      {
        kind: 'text',
        id: 'ui-title',
        x: 12,
        y: 8,
        width: 240,
        height: 24,
        text: 'Deterministic HUD',
        colorRgba: 0xff_ff_ff_ff,
        fontSizePx: 16,
      },
      {
        kind: 'meter',
        id: 'ui-meter',
        x: 12,
        y: 40,
        width: 240,
        height: 12,
        value: 5,
        max: 20,
        fillColorRgba: 0x2a_4f_8a_ff,
        backgroundColorRgba: 0x18_2a_44_ff,
      },
      {
        kind: 'rect',
        id: 'ui-panel',
        x: 8,
        y: 32,
        width: 260,
        height: 32,
        colorRgba: 0x00_00_00_b3,
      },
    ],
  },
};
