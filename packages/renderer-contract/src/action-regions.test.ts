import { describe, expect, it } from 'vitest';

import {
  hitTestActionRegions,
  isPointInActionRegion,
} from './action-regions.js';
import type { RenderActionRegion } from './types.js';

const createRegion = (
  id: string,
  overrides: Partial<RenderActionRegion> = {},
): RenderActionRegion => ({
  id,
  actionId: id,
  actionType: 'button',
  x: 10,
  y: 20,
  width: 30,
  height: 40,
  enabled: true,
  ...overrides,
});

describe('action region hit testing', () => {
  it('uses render-command UI bounds with exclusive right and bottom edges', () => {
    const region = createRegion('collect');

    expect(isPointInActionRegion(region, 10, 20)).toBe(true);
    expect(isPointInActionRegion(region, 39, 59)).toBe(true);
    expect(isPointInActionRegion(region, 40, 59)).toBe(false);
    expect(isPointInActionRegion(region, 39, 60)).toBe(false);
    expect(isPointInActionRegion(region, Number.NaN, 30)).toBe(false);
  });

  it('returns the latest matching region for overlapping bounds', () => {
    const bottom = createRegion('bottom', { x: 0, y: 0, width: 40, height: 40 });
    const top = createRegion('top', { x: 20, y: 20, width: 40, height: 40 });

    expect(hitTestActionRegions([bottom, top], 25, 25)).toBe(top);
    expect(hitTestActionRegions([bottom, top], 10, 10)).toBe(bottom);
  });

  it('skips disabled regions for dispatch but can include them for diagnostics', () => {
    const disabled = createRegion('disabled', { enabled: false });

    expect(hitTestActionRegions([disabled], 12, 22)).toBeUndefined();
    expect(
      hitTestActionRegions([disabled], 12, 22, { includeDisabled: true }),
    ).toBe(disabled);
  });

  it('does not fall through a disabled top region to an enabled region below it', () => {
    const enabled = createRegion('enabled', { x: 0, y: 0, width: 40, height: 40 });
    const disabled = createRegion('disabled', {
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      enabled: false,
    });

    expect(hitTestActionRegions([enabled, disabled], 10, 10)).toBeUndefined();
    expect(
      hitTestActionRegions([enabled, disabled], 10, 10, { includeDisabled: true }),
    ).toBe(disabled);
  });

  it('returns undefined for out-of-bounds pointer events', () => {
    const region = createRegion('collect');

    expect(hitTestActionRegions([region], 9, 20)).toBeUndefined();
    expect(hitTestActionRegions([region], 10, 19)).toBeUndefined();
    expect(hitTestActionRegions([region], 40, 20)).toBeUndefined();
    expect(hitTestActionRegions([region], 10, 60)).toBeUndefined();
  });
});
