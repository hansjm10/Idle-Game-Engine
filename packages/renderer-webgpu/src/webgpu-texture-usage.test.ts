import { describe, expect, it } from 'vitest';
import { __test__ } from './webgpu-renderer.js';

describe('getCopyExternalImageToTextureDestinationUsage', () => {
  it('includes COPY_DST and RENDER_ATTACHMENT usage bits', () => {
    const COPY_DST = 2;
    const TEXTURE_BINDING = 4;
    const RENDER_ATTACHMENT = 16;

    const usage = __test__.getCopyExternalImageToTextureDestinationUsage(TEXTURE_BINDING);

    expect(usage & COPY_DST).toBe(COPY_DST);
    expect(usage & TEXTURE_BINDING).toBe(TEXTURE_BINDING);
    expect(usage & RENDER_ATTACHMENT).toBe(RENDER_ATTACHMENT);
  });
});

