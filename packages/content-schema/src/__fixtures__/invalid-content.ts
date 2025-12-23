const baseTitle = {
  default: 'Fixture',
  variants: {},
} as const;

export const duplicateResourceIdsFixture = {
  metadata: {
    id: 'duplicate-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary',
      tier: 1,
    },
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary',
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
};

export const dependencyCycleFixture = {
  metadata: {
    id: 'cycle-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
    dependencies: {
      requires: [{ packId: 'cycle-pack', version: '^1.0.0' }],
    },
  },
  resources: [],
  generators: [],
  upgrades: [],
};

export const invalidCrossReferenceFixture = {
  metadata: {
    id: 'bad-ref-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary',
      tier: 1,
    },
  ],
  generators: [
    {
      id: 'reactor',
      name: baseTitle,
      produces: [
        { resourceId: 'missing-resource', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [],
      purchase: {
        currencyId: 'energy',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' },
    },
  ],
  upgrades: [
    {
      id: 'boost',
      name: baseTitle,
      category: 'global',
      targets: [{ kind: 'global' }],
      cost: {
        currencyId: 'energy',
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: 'missing-resource',
          operation: 'add',
          value: { kind: 'constant', value: 1 },
        },
      ],
    },
  ],
};
