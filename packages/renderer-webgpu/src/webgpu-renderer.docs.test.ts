import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('renderer-webgpu docs', () => {
  it('documents copyExternalImageToTexture backend variance and references', () => {
    const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
    const readme = readFileSync(readmePath, 'utf8');

    expect(readme).toContain('copyExternalImageToTexture');
    expect(readme).toContain('RENDER_ATTACHMENT');
    expect(readme).toContain('https://github.com/gpuweb/gpuweb/issues/3357');
    expect(readme).toContain(
      'https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/copyExternalImageToTexture',
    );
  });
});

