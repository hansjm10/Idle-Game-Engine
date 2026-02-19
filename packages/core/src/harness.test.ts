import { describe, expect, it } from 'vitest';

import {
  buildProgressionSnapshot as buildProgressionSnapshotBrowser,
  loadGameStateSaveFormat as loadGameStateSaveFormatBrowser,
} from './harness.browser.js';
import {
  buildProgressionSnapshot as buildProgressionSnapshotNode,
  loadGameStateSaveFormat as loadGameStateSaveFormatNode,
} from './harness.js';
import { buildProgressionSnapshot } from './progression.js';
import { loadGameStateSaveFormat } from './game-state-save.js';

describe('harness entrypoints', () => {
  it('re-exports the supported helpers from the browser-safe surface', () => {
    expect(loadGameStateSaveFormatBrowser).toBe(loadGameStateSaveFormat);
    expect(buildProgressionSnapshotBrowser).toBe(buildProgressionSnapshot);
  });

  it('re-exports the browser surface from the node entrypoint', () => {
    expect(loadGameStateSaveFormatNode).toBe(loadGameStateSaveFormatBrowser);
    expect(buildProgressionSnapshotNode).toBe(buildProgressionSnapshotBrowser);
  });
});
