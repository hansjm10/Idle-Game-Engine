export interface ResourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly startAmount: number;
}

export interface GeneratorDefinition {
  readonly id: string;
  readonly name: string;
  readonly produces: string;
  readonly baseRate: number;
  readonly cost: number;
}

export interface ContentPack {
  readonly metadata: {
    readonly id: string;
    readonly version: string;
    readonly engine: string;
  };
  readonly resources: readonly ResourceDefinition[];
  readonly generators: readonly GeneratorDefinition[];
}

/**
 * Minimal reference content pack aligned with the prototype milestone. Real
 * data will be generated from the DSL compiler in later iterations.
 */
export const sampleContent: ContentPack = {
  metadata: {
    id: 'sample-pack',
    version: '0.1.0',
    engine: '0.1.x'
  },
  resources: [
    { id: 'energy', name: 'Energy', startAmount: 10 },
    { id: 'crystal', name: 'Crystal', startAmount: 0 }
  ],
  generators: [
    {
      id: 'reactor',
      name: 'Reactor',
      produces: 'energy',
      baseRate: 1,
      cost: 10
    },
    {
      id: 'harvester',
      name: 'Crystal Harvester',
      produces: 'crystal',
      baseRate: 0.25,
      cost: 25
    }
  ]
};
