import { RENDERER_CONTRACT_SCHEMA_VERSION } from '../types.js';
export const renderCompilerFixtureViewModel = {
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
                assetId: 'asset:sprite-b',
                x: 1.1,
                y: -2.03,
                z: 0,
                width: 3.333,
                height: 4.666,
                tintRgba: 574908159,
            },
            {
                id: 'sprite-a',
                assetId: 'asset:sprite-a',
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
                colorRgba: 4294967295,
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
                fillColorRgba: 709855999,
                backgroundColorRgba: 405423359,
            },
            {
                kind: 'rect',
                id: 'ui-panel',
                x: 8,
                y: 32,
                width: 260,
                height: 32,
                colorRgba: 179,
            },
        ],
    },
};
//# sourceMappingURL=render-compiler.js.map