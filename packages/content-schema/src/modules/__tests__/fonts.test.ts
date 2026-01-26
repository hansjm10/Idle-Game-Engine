import { describe, expect, it } from 'vitest';

import { fontCollectionSchema } from '../fonts.js';

describe('fontCollectionSchema', () => {
  it('normalizes ids, defaults ranges, and sorts by id', () => {
    const fonts = fontCollectionSchema.parse([
      {
        id: 'Ui-Font',
        source: 'fonts/ui.ttf',
        baseSizePx: 42,
      },
      {
        id: 'body-font',
        source: 'fonts/body.ttf',
        baseSizePx: 42,
        codePointRanges: [
          [97, 122],
          [65, 90],
          [88, 92],
        ],
      },
    ]);

    expect(fonts.map((font) => font.id)).toEqual(['body-font', 'ui-font']);
    expect(fonts[1]?.codePointRanges).toEqual([[32, 126]]);
    expect(fonts[0]?.codePointRanges).toEqual([
      [65, 92],
      [97, 122],
    ]);
  });

  it('rejects unsafe source paths', () => {
    expect(() =>
      fontCollectionSchema.parse([
        {
          id: 'ui-font',
          source: '../fonts/ui.ttf',
          baseSizePx: 42,
        },
      ]),
    ).toThrowError(/safe relative posix path/i);

    expect(() =>
      fontCollectionSchema.parse([
        {
          id: 'ui-font',
          source: 'C:/fonts/ui.ttf',
          baseSizePx: 42,
        },
      ]),
    ).toThrowError(/safe relative posix path/i);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      fontCollectionSchema.parse([
        {
          id: 'ui-font',
          source: 'fonts/ui.ttf',
          baseSizePx: 42,
        },
        {
          id: 'ui-font',
          source: 'fonts/ui2.ttf',
          baseSizePx: 42,
        },
      ]),
    ).toThrowError(/duplicate font id/i);
  });
});

