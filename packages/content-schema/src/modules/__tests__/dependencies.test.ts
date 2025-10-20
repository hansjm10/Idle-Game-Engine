import { describe, expect, it } from 'vitest';

import { dependencyCollectionSchema } from '../dependencies.js';

describe('dependencyCollectionSchema', () => {
  it('sorts dependency entries deterministically', () => {
    const result = dependencyCollectionSchema.parse({
      requires: [
        { packId: '@idle-engine/core', version: '^0.2.0' },
        { packId: 'automation-tools', version: '^1.0.0' },
      ],
      optional: [
        { packId: 'docs-pack', version: '^1.0.0' },
        { packId: 'analytics-pack' },
      ],
      conflicts: [
        { packId: 'legacy-pack', message: 'Migrate to >=2.0.0' },
        { packId: 'legacy-pack-2' },
      ],
      provides: ['Gameplay', 'gameplay', 'automation-api'],
    });

    expect(result.requires).toEqual([
      { packId: '@idle-engine/core', version: '>=0.2.0-0 <0.3.0-0' },
      { packId: 'automation-tools', version: '>=1.0.0 <2.0.0-0' },
    ]);
    expect(result.optional).toEqual([
      { packId: 'analytics-pack' },
      { packId: 'docs-pack', version: '>=1.0.0 <2.0.0-0' },
    ]);
    expect(result.conflicts).toEqual([
      { packId: 'legacy-pack', message: 'Migrate to >=2.0.0' },
      { packId: 'legacy-pack-2' },
    ]);
    expect(result.provides).toEqual(['automation-api', 'gameplay']);
  });

  it('rejects duplicate dependency edges', () => {
    expect(() =>
      dependencyCollectionSchema.parse({
        requires: [
          { packId: 'shared-pack', version: '^1.0.0' },
          { packId: 'shared-pack' },
        ],
      }),
    ).toThrowError(/duplicate/i);
  });
});
