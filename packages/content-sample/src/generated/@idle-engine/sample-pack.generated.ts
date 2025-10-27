import {
  createModuleIndices,
  rehydrateNormalizedPack,
} from '@idle-engine/content-compiler/runtime';
import {
  type SerializedNormalizedContentPack,
} from '@idle-engine/content-compiler';

const serialized = {
  "artifactHash": "2da1fd87197e04331700933cb8f423c34473b8c1eb8ce9dc95c93b0c867388a8",
  "digest": {
    "hash": "fnv1a-ee949ca5",
    "version": 1
  },
  "formatVersion": 1,
  "metadata": {
    "authors": [
      "Idle Engine Team"
    ],
    "defaultLocale": "en-US",
    "engine": ">=0.4.0 <0.6.0",
    "id": "@idle-engine/sample-pack",
    "links": [
      {
        "href": "https://github.com/hansjm10/Idle-Game-Engine/blob/main/docs/content-dsl-schema-design.md",
        "kind": "docs",
        "label": "Content Schema Design"
      }
    ],
    "summary": {
      "default": "Reference data for the prototype milestone and automated tests.",
      "variants": {
        "en-US": "Reference data for the prototype milestone and automated tests."
      }
    },
    "supportedLocales": [
      "en-US"
    ],
    "tags": [
      "prototype",
      "sample"
    ],
    "title": {
      "default": "Sample Content Pack",
      "variants": {
        "en-US": "Sample Content Pack"
      }
    },
    "version": "0.2.0"
  },
  "modules": {
    "achievements": [
      {
        "category": "progression",
        "description": {
          "default": "Generate one unit of energy.",
          "variants": {
            "en-US": "Generate one unit of energy."
          }
        },
        "id": "sample-pack.first-energy",
        "name": {
          "default": "First Spark",
          "variants": {
            "en-US": "First Spark"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 1
          }
        },
        "tags": [],
        "tier": "bronze",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "sample-pack.energy",
          "threshold": {
            "kind": "constant",
            "value": 1
          }
        }
      }
    ],
    "automations": [],
    "generators": [
      {
        "baseUnlock": {
          "kind": "always"
        },
        "consumes": [],
        "effects": [],
        "id": "sample-pack.reactor",
        "name": {
          "default": "Reactor",
          "variants": {
            "en-US": "Reactor"
          }
        },
        "order": 1,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "sample-pack.energy"
          }
        ],
        "purchase": {
          "baseCost": 10,
          "costCurve": {
            "base": 10,
            "growth": 1.15,
            "kind": "exponential",
            "offset": 0
          },
          "currencyId": "sample-pack.energy"
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "amount": {
            "kind": "constant",
            "value": 15
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.5
            },
            "resourceId": "sample-pack.energy"
          }
        ],
        "effects": [],
        "id": "sample-pack.harvester",
        "name": {
          "default": "Crystal Harvester",
          "variants": {
            "en-US": "Crystal Harvester"
          }
        },
        "order": 2,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.25
            },
            "resourceId": "sample-pack.crystal"
          }
        ],
        "purchase": {
          "baseCost": 25,
          "costCurve": {
            "base": 25,
            "kind": "linear",
            "slope": 5
          },
          "currencyId": "sample-pack.energy"
        },
        "tags": []
      }
    ],
    "guildPerks": [],
    "metrics": [
      {
        "attributes": [],
        "description": {
          "default": "Cumulative energy yield tracked across all runs.",
          "variants": {
            "en-US": "Cumulative energy yield tracked across all runs."
          }
        },
        "id": "sample-pack.energy-produced",
        "kind": "counter",
        "name": {
          "default": "Total Energy Produced",
          "variants": {
            "en-US": "Total Energy Produced"
          }
        },
        "source": {
          "kind": "runtime"
        },
        "unit": "units"
      }
    ],
    "prestigeLayers": [],
    "resources": [
      {
        "capacity": 100,
        "category": "primary",
        "id": "sample-pack.energy",
        "name": {
          "default": "Energy",
          "variants": {
            "en-US": "Energy"
          }
        },
        "order": 1,
        "startAmount": 10,
        "tags": [],
        "tier": 1,
        "unlocked": true,
        "visible": true
      },
      {
        "capacity": 0,
        "category": "currency",
        "id": "sample-pack.crystal",
        "name": {
          "default": "Crystal",
          "variants": {
            "en-US": "Crystal"
          }
        },
        "order": 2,
        "startAmount": 0,
        "tags": [],
        "tier": 1,
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 25
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy"
        },
        "unlocked": false,
        "visible": true
      }
    ],
    "runtimeEvents": [],
    "transforms": [],
    "upgrades": []
  },
  "warnings": []
} as unknown as SerializedNormalizedContentPack;

const runtimeEnv = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process;

const shouldVerifyDigest = runtimeEnv?.env?.NODE_ENV !== 'production';

export const PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK = rehydrateNormalizedPack(serialized, {
  verifyDigest: shouldVerifyDigest,
});
export const PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_DIGEST = serialized.digest;
export const PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_ARTIFACT_HASH = serialized.artifactHash;
export const PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_INDICES = createModuleIndices(PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK);
export const PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_SUMMARY = Object.freeze({
  slug: serialized.metadata.id,
  version: serialized.metadata.version,
  digest: serialized.digest,
  artifactHash: serialized.artifactHash,
  warningCount: serialized.warnings.length,
  resourceIds: serialized.modules.resources.map((resource) => resource.id),
});

