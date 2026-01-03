import {
  createModuleIndices,
  rehydrateNormalizedPack,
} from '@idle-engine/content-compiler/runtime';

const serialized = {
  "artifactHash": "e6adf3be76002ed6a97b152add6df56e5d1cc72b617f4a355e109d2755a3dc23",
  "digest": {
    "hash": "fnv1a-1dbda158",
    "version": 1
  },
  "formatVersion": 1,
  "metadata": {
    "authors": [
      "Idle Engine Team"
    ],
    "defaultLocale": "en-US",
    "engine": ">=0.4.0 <1.0.0",
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
    "version": "0.3.0"
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
    "automations": [
      {
        "cooldown": {
          "kind": "constant",
          "value": 5000
        },
        "description": {
          "default": "Enables crystal harvester when you reach 50 energy",
          "variants": {
            "en-US": "Enables crystal harvester when you reach 50 energy"
          }
        },
        "enabledByDefault": false,
        "id": "sample-pack.auto-harvester-on-energy",
        "name": {
          "default": "Smart Harvester Enabler",
          "variants": {
            "en-US": "Smart Harvester Enabler"
          }
        },
        "order": 2,
        "targetId": "sample-pack.harvester",
        "targetType": "generator",
        "trigger": {
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy",
          "threshold": {
            "kind": "constant",
            "value": 50
          }
        },
        "unlockCondition": {
          "kind": "always"
        }
      },
      {
        "description": {
          "default": "Enables crystal harvester when reactor is primed",
          "variants": {
            "en-US": "Enables crystal harvester when reactor is primed"
          }
        },
        "enabledByDefault": false,
        "id": "sample-pack.auto-harvester-on-primed",
        "name": {
          "default": "Auto-Harvest on Reactor Prime",
          "variants": {
            "en-US": "Auto-Harvest on Reactor Prime"
          }
        },
        "order": 4,
        "targetId": "sample-pack.harvester",
        "targetType": "generator",
        "trigger": {
          "eventId": "sample:reactor-primed",
          "kind": "event"
        },
        "unlockCondition": {
          "kind": "always"
        }
      },
      {
        "description": {
          "default": "Automatically enables the reactor every 5 seconds",
          "variants": {
            "en-US": "Automatically enables the reactor every 5 seconds"
          }
        },
        "enabledByDefault": true,
        "id": "sample-pack.auto-reactor",
        "name": {
          "default": "Reactor Auto-Clicker",
          "variants": {
            "en-US": "Reactor Auto-Clicker"
          }
        },
        "order": 1,
        "targetId": "sample-pack.reactor",
        "targetType": "generator",
        "trigger": {
          "interval": {
            "kind": "constant",
            "value": 5000
          },
          "kind": "interval"
        },
        "unlockCondition": {
          "kind": "always"
        }
      },
      {
        "description": {
          "default": "Enables the reactor periodically",
          "variants": {
            "en-US": "Enables the reactor periodically"
          }
        },
        "enabledByDefault": false,
        "id": "sample-pack.auto-reactor-burst",
        "name": {
          "default": "Reactor Burst (Costed)",
          "variants": {
            "en-US": "Reactor Burst (Costed)"
          }
        },
        "order": 6,
        "resourceCost": {
          "rate": {
            "kind": "constant",
            "value": 2
          },
          "resourceId": "sample-pack.energy"
        },
        "targetId": "sample-pack.reactor",
        "targetType": "generator",
        "trigger": {
          "interval": {
            "kind": "constant",
            "value": 2000
          },
          "kind": "interval"
        },
        "unlockCondition": {
          "kind": "always"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 0
        },
        "description": {
          "default": "Attempts to buy Reactor Insulation every 8 seconds",
          "variants": {
            "en-US": "Attempts to buy Reactor Insulation every 8 seconds"
          }
        },
        "enabledByDefault": false,
        "id": "sample-pack.autobuy-reactor-insulation",
        "name": {
          "default": "Auto-Buy Reactor Insulation",
          "variants": {
            "en-US": "Auto-Buy Reactor Insulation"
          }
        },
        "order": 8,
        "resourceCost": {
          "rate": {
            "kind": "constant",
            "value": 1
          },
          "resourceId": "sample-pack.energy"
        },
        "targetId": "sample-pack.reactor-insulation",
        "targetType": "upgrade",
        "trigger": {
          "interval": {
            "kind": "constant",
            "value": 8000
          },
          "kind": "interval"
        },
        "unlockCondition": {
          "kind": "always"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 10000
        },
        "description": {
          "default": "Collects resources when no other actions are pending",
          "variants": {
            "en-US": "Collects resources when no other actions are pending"
          }
        },
        "enabledByDefault": true,
        "id": "sample-pack.idle-collector",
        "name": {
          "default": "Idle Resource Collector",
          "variants": {
            "en-US": "Idle Resource Collector"
          }
        },
        "order": 3,
        "targetId": "sample-pack.reactor",
        "targetType": "generator",
        "trigger": {
          "kind": "commandQueueEmpty"
        },
        "unlockCondition": {
          "kind": "always"
        }
      }
    ],
    "entities": [],
    "generators": [
      {
        "baseUnlock": {
          "kind": "always"
        },
        "consumes": [],
        "effects": [],
        "id": "sample-pack.reactor",
        "initialLevel": 0,
        "maxLevel": 50,
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
          "costCurve": {
            "base": 10,
            "growth": 1.15,
            "kind": "exponential",
            "offset": 0
          },
          "costMultiplier": 10,
          "currencyId": "sample-pack.energy",
          "maxBulk": 10
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
        "initialLevel": 0,
        "maxLevel": 40,
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
          "costCurve": {
            "base": 25,
            "kind": "linear",
            "slope": 5
          },
          "costMultiplier": 25,
          "currencyId": "sample-pack.energy",
          "maxBulk": 5
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "amount": {
            "kind": "constant",
            "value": 50
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.crystal"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 1.5
            },
            "resourceId": "sample-pack.energy"
          },
          {
            "rate": {
              "kind": "constant",
              "value": 0.35
            },
            "resourceId": "sample-pack.crystal"
          }
        ],
        "effects": [],
        "id": "sample-pack.forge",
        "initialLevel": 0,
        "maxLevel": 35,
        "name": {
          "default": "Forge",
          "variants": {
            "en-US": "Forge"
          }
        },
        "order": 3,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.2
            },
            "resourceId": "sample-pack.alloy"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 75,
            "kind": "linear",
            "slope": 12
          },
          "costMultiplier": 1,
          "currencyId": "sample-pack.energy",
          "maxBulk": 5
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "amount": {
            "kind": "constant",
            "value": 40
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.alloy"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 2.5
            },
            "resourceId": "sample-pack.energy"
          },
          {
            "rate": {
              "kind": "constant",
              "value": 0.5
            },
            "resourceId": "sample-pack.alloy"
          }
        ],
        "effects": [],
        "id": "sample-pack.lab",
        "initialLevel": 0,
        "maxLevel": 25,
        "name": {
          "default": "Research Lab",
          "variants": {
            "en-US": "Research Lab"
          }
        },
        "order": 4,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.08
            },
            "resourceId": "sample-pack.data-core"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 1,
            "growth": 1.12,
            "kind": "exponential"
          },
          "costMultiplier": 120,
          "currencyId": "sample-pack.energy",
          "maxBulk": 3
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "conditions": [
            {
              "kind": "prestigeUnlocked",
              "prestigeLayerId": "sample-pack.ascension-alpha"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 200
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "sample-pack.data-core"
            }
          ],
          "kind": "allOf"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 2
            },
            "resourceId": "sample-pack.data-core"
          }
        ],
        "effects": [],
        "id": "sample-pack.gate-reactor",
        "initialLevel": 0,
        "maxLevel": 15,
        "name": {
          "default": "Gate Reactor",
          "variants": {
            "en-US": "Gate Reactor"
          }
        },
        "order": 5,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.05
            },
            "resourceId": "sample-pack.prestige-flux"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 1,
            "growth": 1.08,
            "kind": "exponential"
          },
          "costMultiplier": 500,
          "currencyId": "sample-pack.data-core",
          "maxBulk": 2
        },
        "tags": [],
        "visibilityCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "sample-pack.ascension-alpha"
        }
      }
    ],
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
    "prestigeLayers": [
      {
        "id": "sample-pack.ascension-alpha",
        "name": {
          "default": "Ascension Alpha",
          "variants": {
            "en-US": "Ascension Alpha"
          }
        },
        "order": 1,
        "resetTargets": [
          "sample-pack.alloy",
          "sample-pack.crystal",
          "sample-pack.data-core",
          "sample-pack.energy"
        ],
        "retention": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "kind": "resource",
            "resourceId": "sample-pack.prestige-flux"
          }
        ],
        "reward": {
          "baseReward": {
            "expression": {
              "args": [
                {
                  "kind": "unary",
                  "op": "floor",
                  "operand": {
                    "kind": "binary",
                    "left": {
                      "kind": "binary",
                      "left": {
                        "kind": "binary",
                        "left": {
                          "kind": "ref",
                          "target": {
                            "id": "sample-pack.energy",
                            "type": "resource"
                          }
                        },
                        "op": "add",
                        "right": {
                          "kind": "ref",
                          "target": {
                            "id": "sample-pack.crystal",
                            "type": "resource"
                          }
                        }
                      },
                      "op": "add",
                      "right": {
                        "kind": "binary",
                        "left": {
                          "kind": "literal",
                          "value": 2
                        },
                        "op": "mul",
                        "right": {
                          "kind": "ref",
                          "target": {
                            "id": "sample-pack.data-core",
                            "type": "resource"
                          }
                        }
                      }
                    },
                    "op": "div",
                    "right": {
                      "kind": "literal",
                      "value": 750
                    }
                  }
                },
                {
                  "kind": "literal",
                  "value": 1
                },
                {
                  "kind": "literal",
                  "value": 5000
                }
              ],
              "kind": "call",
              "name": "clamp"
            },
            "kind": "expression"
          },
          "resourceId": "sample-pack.prestige-flux"
        },
        "summary": {
          "default": "Reset generators and upgrades for long-term flux; unlock once your reactor hums at level 10 and data cores reach 500.",
          "variants": {
            "en-US": "Reset generators and upgrades for long-term flux; unlock once your reactor hums at level 10 and data cores reach 500."
          }
        },
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 500
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "sample-pack.data-core"
            },
            {
              "comparator": "gte",
              "generatorId": "sample-pack.reactor",
              "kind": "generatorLevel",
              "level": {
                "kind": "constant",
                "value": 10
              }
            }
          ],
          "kind": "allOf"
        }
      }
    ],
    "resources": [
      {
        "capacity": 100,
        "category": "primary",
        "economyClassification": "soft",
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
        "capacity": null,
        "category": "currency",
        "economyClassification": "hard",
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
      },
      {
        "capacity": null,
        "category": "primary",
        "economyClassification": "soft",
        "id": "sample-pack.alloy",
        "name": {
          "default": "Alloy",
          "variants": {
            "en-US": "Alloy"
          }
        },
        "order": 3,
        "startAmount": 0,
        "tags": [],
        "tier": 2,
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 50
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.crystal"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "primary",
        "economyClassification": "soft",
        "id": "sample-pack.data-core",
        "name": {
          "default": "Data Core",
          "variants": {
            "en-US": "Data Core"
          }
        },
        "order": 4,
        "startAmount": 0,
        "tags": [],
        "tier": 2,
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 40
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.alloy"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "prestige",
        "economyClassification": "soft",
        "id": "sample-pack.prestige-flux",
        "name": {
          "default": "Prestige Flux",
          "variants": {
            "en-US": "Prestige Flux"
          }
        },
        "order": 5,
        "prestige": {
          "layerId": "sample-pack.ascension-alpha",
          "resetRetention": {
            "kind": "constant",
            "value": 1
          }
        },
        "startAmount": 0,
        "tags": [],
        "tier": 3,
        "unlockCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "sample-pack.ascension-alpha"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "misc",
        "economyClassification": "soft",
        "id": "sample-pack.ascension-alpha-prestige-count",
        "name": {
          "default": "Ascension Count",
          "variants": {
            "en-US": "Ascension Count"
          }
        },
        "order": 6,
        "startAmount": 0,
        "tags": [],
        "tier": 3,
        "unlocked": true,
        "visible": false
      }
    ],
    "runtimeEvents": [],
    "transforms": [
      {
        "description": {
          "default": "Smelt alloy into data cores over time.",
          "variants": {
            "en-US": "Smelt alloy into data cores over time."
          }
        },
        "duration": {
          "kind": "constant",
          "value": 30000
        },
        "id": "sample-pack.batch-data-core",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 2
            },
            "resourceId": "sample-pack.alloy"
          },
          {
            "amount": {
              "kind": "constant",
              "value": 40
            },
            "resourceId": "sample-pack.energy"
          }
        ],
        "mode": "batch",
        "name": {
          "default": "Batch Data Core",
          "variants": {
            "en-US": "Batch Data Core"
          }
        },
        "order": 3,
        "outputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "sample-pack.data-core"
          }
        ],
        "safety": {
          "maxOutstandingBatches": 5
        },
        "tags": [],
        "trigger": {
          "kind": "manual"
        },
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 40
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.alloy"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 10000
        },
        "description": {
          "default": "Fuse energy and crystals into alloy when the reactor primes.",
          "variants": {
            "en-US": "Fuse energy and crystals into alloy when the reactor primes."
          }
        },
        "id": "sample-pack.primed-alloy",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 15
            },
            "resourceId": "sample-pack.energy"
          },
          {
            "amount": {
              "kind": "constant",
              "value": 5
            },
            "resourceId": "sample-pack.crystal"
          }
        ],
        "mode": "instant",
        "name": {
          "default": "Primed Alloy",
          "variants": {
            "en-US": "Primed Alloy"
          }
        },
        "order": 2,
        "outputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "sample-pack.alloy"
          }
        ],
        "tags": [],
        "trigger": {
          "eventId": "sample:reactor-primed",
          "kind": "event"
        },
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 50
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.crystal"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 5000
        },
        "description": {
          "default": "Condense energy into crystallized shards.",
          "variants": {
            "en-US": "Condense energy into crystallized shards."
          }
        },
        "id": "sample-pack.refine-crystal",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 20
            },
            "resourceId": "sample-pack.energy"
          }
        ],
        "mode": "instant",
        "name": {
          "default": "Refine Crystal",
          "variants": {
            "en-US": "Refine Crystal"
          }
        },
        "order": 1,
        "outputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "sample-pack.crystal"
          }
        ],
        "tags": [],
        "trigger": {
          "kind": "manual"
        },
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 25
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy"
        }
      }
    ],
    "upgrades": [
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 75,
          "currencyId": "sample-pack.energy"
        },
        "description": {
          "default": "Increases reactor output by 25% through better heat management.",
          "variants": {
            "en-US": "Increases reactor output by 25% through better heat management."
          }
        },
        "effects": [
          {
            "generatorId": "sample-pack.reactor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.25
            }
          },
          {
            "eventId": "sample:reactor-primed",
            "kind": "emitEvent"
          }
        ],
        "id": "sample-pack.reactor-insulation",
        "name": {
          "default": "Reactor Insulation",
          "variants": {
            "en-US": "Reactor Insulation"
          }
        },
        "order": 1,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.reactor",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 50
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy"
        },
        "visibilityCondition": {
          "kind": "always"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 150,
          "currencyId": "sample-pack.energy"
        },
        "description": {
          "default": "Pushes reactor beyond safe limits for 50% more energy generation.",
          "variants": {
            "en-US": "Pushes reactor beyond safe limits for 50% more energy generation."
          }
        },
        "effects": [
          {
            "generatorId": "sample-pack.reactor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.5
            }
          }
        ],
        "id": "sample-pack.reactor-overclock",
        "name": {
          "default": "Reactor Overclock",
          "variants": {
            "en-US": "Reactor Overclock"
          }
        },
        "order": 2,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.reactor-insulation"
          }
        ],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.reactor",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 100
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.energy"
        },
        "visibilityCondition": {
          "kind": "always"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 400,
          "currencyId": "sample-pack.energy"
        },
        "description": {
          "default": "Advanced cooling technology allows for 75% increased reactor efficiency.",
          "variants": {
            "en-US": "Advanced cooling technology allows for 75% increased reactor efficiency."
          }
        },
        "effects": [
          {
            "generatorId": "sample-pack.reactor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.75
            }
          }
        ],
        "id": "sample-pack.reactor-phase-cooling",
        "name": {
          "default": "Reactor Phase Cooling",
          "variants": {
            "en-US": "Reactor Phase Cooling"
          }
        },
        "order": 3,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.reactor-overclock"
          }
        ],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.reactor",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "sample-pack.reactor",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 5
          }
        },
        "visibilityCondition": {
          "kind": "always"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 125,
          "currencyId": "sample-pack.energy"
        },
        "effects": [
          {
            "generatorId": "sample-pack.harvester",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.5
            }
          }
        ],
        "id": "sample-pack.harvester-efficiency",
        "name": {
          "default": "Harvester Efficiency",
          "variants": {
            "en-US": "Harvester Efficiency"
          }
        },
        "order": 4,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.harvester",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "sample-pack.harvester",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 1
          }
        },
        "visibilityCondition": {
          "amount": {
            "kind": "constant",
            "value": 20
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.crystal"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 200,
          "currencyId": "sample-pack.crystal"
        },
        "effects": [
          {
            "generatorId": "sample-pack.harvester",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.5
            }
          }
        ],
        "id": "sample-pack.harvester-deep-core",
        "name": {
          "default": "Harvester Deep Core",
          "variants": {
            "en-US": "Harvester Deep Core"
          }
        },
        "order": 5,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.harvester-efficiency"
          }
        ],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.harvester",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 150
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.crystal"
        },
        "visibilityCondition": {
          "kind": "always"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 250,
          "currencyId": "sample-pack.crystal",
          "maxBulk": 2
        },
        "effects": [
          {
            "generatorId": "sample-pack.harvester",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.15
            }
          }
        ],
        "id": "sample-pack.harvester-quantum-sieve",
        "name": {
          "default": "Harvester Quantum Sieve",
          "variants": {
            "en-US": "Harvester Quantum Sieve"
          }
        },
        "order": 6,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.harvester-deep-core"
          }
        ],
        "repeatable": {
          "costCurve": {
            "base": 1,
            "kind": "linear",
            "slope": 0.25
          },
          "maxPurchases": 5
        },
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.harvester",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 200
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "sample-pack.crystal"
            },
            {
              "comparator": "gte",
              "generatorId": "sample-pack.harvester",
              "kind": "generatorLevel",
              "level": {
                "kind": "constant",
                "value": 3
              }
            }
          ],
          "kind": "allOf"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 320,
          "currencyId": "sample-pack.energy"
        },
        "effects": [
          {
            "generatorId": "sample-pack.forge",
            "kind": "modifyGeneratorCost",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 0.9
            }
          }
        ],
        "id": "sample-pack.forge-heat-shield",
        "name": {
          "default": "Forge Heat Shield",
          "variants": {
            "en-US": "Forge Heat Shield"
          }
        },
        "order": 7,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.forge",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "sample-pack.forge",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 1
          }
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "base": 1,
            "kind": "linear",
            "slope": 0.15
          },
          "costMultiplier": 180,
          "currencyId": "sample-pack.alloy"
        },
        "effects": [
          {
            "generatorId": "sample-pack.forge",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.3
            }
          }
        ],
        "id": "sample-pack.forge-auto-feed",
        "name": {
          "default": "Forge Auto-Feed",
          "variants": {
            "en-US": "Forge Auto-Feed"
          }
        },
        "order": 8,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.forge-heat-shield"
          }
        ],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.forge",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 30
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.alloy"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 220,
          "currencyId": "sample-pack.alloy"
        },
        "effects": [
          {
            "generatorId": "sample-pack.lab",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.4
            }
          }
        ],
        "id": "sample-pack.lab-insight-boost",
        "name": {
          "default": "Lab Insight Boost",
          "variants": {
            "en-US": "Lab Insight Boost"
          }
        },
        "order": 9,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.lab",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 40
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.alloy"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 1,
          "currencyId": "sample-pack.prestige-flux"
        },
        "effects": [
          {
            "generatorId": "sample-pack.lab",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1.05
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.02
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "name": "level",
                      "type": "variable"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          }
        ],
        "id": "sample-pack.lab-simulation-stack",
        "name": {
          "default": "Lab Simulation Stack",
          "variants": {
            "en-US": "Lab Simulation Stack"
          }
        },
        "order": 10,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "sample-pack.lab-insight-boost"
          }
        ],
        "repeatable": {
          "costCurve": {
            "base": 1,
            "growth": 1.1,
            "kind": "exponential"
          },
          "maxPurchases": 10
        },
        "tags": [],
        "targets": [
          {
            "id": "sample-pack.lab",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 1
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.prestige-flux"
        }
      },
      {
        "category": "prestige",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 0,
          "currencyId": "sample-pack.prestige-flux"
        },
        "effects": [
          {
            "generatorId": "sample-pack.reactor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.01
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "id": "sample-pack.prestige-flux",
                      "type": "resource"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          },
          {
            "generatorId": "sample-pack.harvester",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.01
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "id": "sample-pack.prestige-flux",
                      "type": "resource"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          },
          {
            "generatorId": "sample-pack.forge",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.01
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "id": "sample-pack.prestige-flux",
                      "type": "resource"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          },
          {
            "generatorId": "sample-pack.lab",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.01
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "id": "sample-pack.prestige-flux",
                      "type": "resource"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          },
          {
            "generatorId": "sample-pack.gate-reactor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "expression": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 1
                },
                "op": "add",
                "right": {
                  "kind": "binary",
                  "left": {
                    "kind": "literal",
                    "value": 0.01
                  },
                  "op": "mul",
                  "right": {
                    "kind": "ref",
                    "target": {
                      "id": "sample-pack.prestige-flux",
                      "type": "resource"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          }
        ],
        "id": "sample-pack.ascension-surge",
        "name": {
          "default": "Ascension Surge",
          "variants": {
            "en-US": "Ascension Surge"
          }
        },
        "order": 11,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "kind": "global"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 1
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "sample-pack.prestige-flux"
        },
        "visibilityCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "sample-pack.ascension-alpha"
        }
      }
    ]
  },
  "warnings": []
} as unknown as Parameters<typeof rehydrateNormalizedPack>[0];

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
  entityIds: serialized.modules.entities.map((entity) => entity.id),
});

