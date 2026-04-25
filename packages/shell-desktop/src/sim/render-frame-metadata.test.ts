import { describe, expect, it } from 'vitest';

import {
  buildLastCompletedRenderFrameMetadata,
  buildRenderFrameMetadata,
} from './render-frame-metadata.js';

describe('render frame metadata', () => {
  it('uses the completed runtime step as the canonical renderer frame step', () => {
    expect(buildRenderFrameMetadata(0, 16)).toEqual({ step: 0, simTimeMs: 0 });
    expect(buildRenderFrameMetadata(7, 16)).toEqual({ step: 7, simTimeMs: 112 });
  });

  it('maps next executable step to the last completed frame without advancing it', () => {
    expect(buildLastCompletedRenderFrameMetadata(0, 16)).toEqual({ step: 0, simTimeMs: 0 });
    expect(buildLastCompletedRenderFrameMetadata(1, 16)).toEqual({ step: 0, simTimeMs: 0 });
    expect(buildLastCompletedRenderFrameMetadata(9, 16)).toEqual({ step: 8, simTimeMs: 128 });
  });
});
