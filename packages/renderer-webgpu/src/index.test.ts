import { describe, expect, it } from 'vitest';
import {
  createWebGpuRenderer,
  WebGpuDeviceLostError,
  WebGpuNotSupportedError,
} from './index.js';

describe('renderer-webgpu index', () => {
  it('re-exports the public runtime API', () => {
    expect(typeof createWebGpuRenderer).toBe('function');

    expect(WebGpuNotSupportedError).toBeInstanceOf(Function);
    const notSupported = new WebGpuNotSupportedError('nope');
    expect(notSupported).toBeInstanceOf(Error);
    expect(notSupported.name).toBe('WebGpuNotSupportedError');

    const lost = new WebGpuDeviceLostError('lost', 'destroyed');
    expect(lost).toBeInstanceOf(Error);
    expect(lost.name).toBe('WebGpuDeviceLostError');
    expect(lost.reason).toBe('destroyed');
  });
});

