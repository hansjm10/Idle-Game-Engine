import {
  createModuleIndices,
  rehydrateNormalizedPack,
} from '@idle-engine/content-compiler/runtime';

const serialized = {
  "artifactHash": "0348ca2c5ceaeab9c46c47c2e79020e8af15efee37cc559939089583055a87ab",
  "digest": {
    "hash": "fnv1a-20e3221b",
    "version": 1
  },
  "formatVersion": 1,
  "metadata": {
    "authors": [
      "Idle Engine Team"
    ],
    "defaultLocale": "en-US",
    "engine": ">=0.5.0 <1.0.0",
    "id": "@idle-engine/test-game",
    "links": [
      {
        "href": "https://github.com/hansjm10/Idle-Game-Engine/blob/main/docs/issue-841-design.md",
        "kind": "docs",
        "label": "Design Document"
      }
    ],
    "summary": {
      "default": "Comprehensive test pack to validate all engine features and edge cases.",
      "variants": {
        "en-US": "Comprehensive test pack to validate all engine features and edge cases."
      }
    },
    "supportedLocales": [
      "en-US"
    ],
    "tags": [
      "internal",
      "test",
      "validation"
    ],
    "title": {
      "default": "Test Game Content Pack",
      "variants": {
        "en-US": "Test Game Content Pack"
      }
    },
    "version": "0.1.0"
  },
  "modules": {
    "achievements": [
      {
        "category": "collection",
        "description": {
          "default": "Unlock all resource tiers.",
          "variants": {
            "en-US": "Unlock all resource tiers."
          }
        },
        "id": "test-game.all-tiers",
        "name": {
          "default": "Resource Master",
          "variants": {
            "en-US": "Resource Master"
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
        "tier": "platinum",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "test-game.omega-points",
          "threshold": {
            "kind": "constant",
            "value": 1
          }
        },
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 1
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gold"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 1
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gems"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 1
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.mana"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 1
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.essence"
            }
          ],
          "kind": "allOf"
        }
      },
      {
        "category": "automation",
        "description": {
          "default": "Unlock the automation system.",
          "variants": {
            "en-US": "Unlock the automation system."
          }
        },
        "id": "test-game.auto-enabled",
        "name": {
          "default": "Automation Enabled",
          "variants": {
            "en-US": "Automation Enabled"
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
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "category": "progression",
        "description": {
          "default": "Reach a custom metric threshold.",
          "variants": {
            "en-US": "Reach a custom metric threshold."
          }
        },
        "id": "test-game.custom-tracker",
        "name": {
          "default": "Metric Milestone",
          "variants": {
            "en-US": "Metric Milestone"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "repeatable",
          "repeatable": {
            "maxRepeats": 10,
            "resetWindow": {
              "kind": "constant",
              "value": 86400000
            },
            "rewardScaling": {
              "kind": "constant",
              "value": 1.1
            }
          },
          "target": {
            "kind": "constant",
            "value": 50000
          }
        },
        "reward": {
          "amount": {
            "kind": "constant",
            "value": 10
          },
          "kind": "grantResource",
          "resourceId": "test-game.gems"
        },
        "tags": [],
        "tier": "gold",
        "track": {
          "kind": "custom-metric",
          "metricId": "test-game.total-gold-earned",
          "threshold": {
            "kind": "constant",
            "value": 50000
          }
        }
      },
      {
        "category": "progression",
        "description": {
          "default": "Tests deeply nested conditions.",
          "variants": {
            "en-US": "Tests deeply nested conditions."
          }
        },
        "id": "test-game.deep-nested",
        "name": {
          "default": "Complex Achievement",
          "variants": {
            "en-US": "Complex Achievement"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 5000
          }
        },
        "tags": [],
        "tier": "silver",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "test-game.gold",
          "threshold": {
            "kind": "constant",
            "value": 5000
          }
        },
        "unlockCondition": {
          "conditions": [
            {
              "conditions": [
                {
                  "comparator": "gte",
                  "generatorId": "test-game.gold-mine",
                  "kind": "generatorLevel",
                  "level": {
                    "kind": "constant",
                    "value": 10
                  }
                },
                {
                  "condition": {
                    "kind": "never"
                  },
                  "kind": "not"
                }
              ],
              "kind": "anyOf"
            },
            {
              "condition": {
                "conditions": [
                  {
                    "kind": "never"
                  },
                  {
                    "kind": "never"
                  }
                ],
                "kind": "allOf"
              },
              "kind": "not"
            }
          ],
          "kind": "allOf"
        }
      },
      {
        "category": "progression",
        "description": {
          "default": "Earn your first gold.",
          "variants": {
            "en-US": "Earn your first gold."
          }
        },
        "id": "test-game.first-gold",
        "name": {
          "default": "First Gold",
          "variants": {
            "en-US": "First Gold"
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
          "resourceId": "test-game.gold",
          "threshold": {
            "kind": "constant",
            "value": 1
          }
        }
      },
      {
        "category": "collection",
        "description": {
          "default": "Own 5 total generator levels.",
          "variants": {
            "en-US": "Own 5 total generator levels."
          }
        },
        "id": "test-game.generator-collector",
        "name": {
          "default": "Generator Collector",
          "variants": {
            "en-US": "Generator Collector"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 5
          }
        },
        "tags": [],
        "tier": "bronze",
        "track": {
          "comparator": "gte",
          "kind": "generator-count",
          "threshold": {
            "kind": "constant",
            "value": 5
          }
        }
      },
      {
        "category": "progression",
        "description": {
          "default": "Accumulate 10000 gold.",
          "variants": {
            "en-US": "Accumulate 10000 gold."
          }
        },
        "id": "test-game.gold-hoarder",
        "name": {
          "default": "Gold Hoarder",
          "variants": {
            "en-US": "Gold Hoarder"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "incremental",
          "target": {
            "kind": "constant",
            "value": 10000
          }
        },
        "tags": [],
        "tier": "silver",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "test-game.gold",
          "threshold": {
            "kind": "constant",
            "value": 10000
          }
        }
      },
      {
        "category": "collection",
        "description": {
          "default": "Have less than 50 gold.",
          "variants": {
            "en-US": "Have less than 50 gold."
          }
        },
        "id": "test-game.low-resource",
        "name": {
          "default": "Minimalist",
          "variants": {
            "en-US": "Minimalist"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 50
          }
        },
        "tags": [],
        "tier": "bronze",
        "track": {
          "comparator": "lt",
          "kind": "resource",
          "resourceId": "test-game.gold",
          "threshold": {
            "kind": "constant",
            "value": 50
          }
        }
      },
      {
        "category": "progression",
        "description": {
          "default": "Reach gold mine level 25.",
          "variants": {
            "en-US": "Reach gold mine level 25."
          }
        },
        "id": "test-game.mine-master",
        "name": {
          "default": "Mine Master",
          "variants": {
            "en-US": "Mine Master"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 25
          }
        },
        "tags": [],
        "tier": "gold",
        "track": {
          "generatorId": "test-game.gold-mine",
          "kind": "generator-level",
          "level": {
            "kind": "constant",
            "value": 25
          }
        }
      },
      {
        "category": "prestige",
        "description": {
          "default": "Earn your first prestige points.",
          "variants": {
            "en-US": "Earn your first prestige points."
          }
        },
        "id": "test-game.prestige-pioneer",
        "name": {
          "default": "Prestige Pioneer",
          "variants": {
            "en-US": "Prestige Pioneer"
          }
        },
        "onUnlockEvents": [
          "test-game:milestone-reached"
        ],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 1
          }
        },
        "tags": [],
        "tier": "platinum",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "test-game.prestige-points",
          "threshold": {
            "kind": "constant",
            "value": 1
          }
        }
      },
      {
        "category": "prestige",
        "description": {
          "default": "Complete 3 ascensions.",
          "variants": {
            "en-US": "Complete 3 ascensions."
          }
        },
        "id": "test-game.speed-runner",
        "name": {
          "default": "Speed Runner",
          "variants": {
            "en-US": "Speed Runner"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "oneShot",
          "target": {
            "kind": "constant",
            "value": 3
          }
        },
        "tags": [],
        "tier": "gold",
        "track": {
          "comparator": "gte",
          "kind": "resource",
          "resourceId": "test-game.ascension-prestige-count",
          "threshold": {
            "kind": "constant",
            "value": 3
          }
        }
      },
      {
        "category": "collection",
        "description": {
          "default": "Purchase 10 upgrades.",
          "variants": {
            "en-US": "Purchase 10 upgrades."
          }
        },
        "id": "test-game.upgrade-collector",
        "name": {
          "default": "Upgrade Collector",
          "variants": {
            "en-US": "Upgrade Collector"
          }
        },
        "onUnlockEvents": [],
        "progress": {
          "mode": "incremental",
          "target": {
            "kind": "constant",
            "value": 1
          }
        },
        "tags": [],
        "tier": "silver",
        "track": {
          "kind": "upgrade-owned",
          "purchases": {
            "kind": "constant",
            "value": 1
          },
          "upgradeId": "test-game.gold-boost"
        }
      }
    ],
    "automations": [
      {
        "cooldown": {
          "kind": "constant",
          "value": 10000
        },
        "description": {
          "default": "Collect gems when gold exceeds 1000.",
          "variants": {
            "en-US": "Collect gems when gold exceeds 1000."
          }
        },
        "enabledByDefault": false,
        "id": "test-game.auto-collect-gems",
        "name": {
          "default": "Auto Collect Gems",
          "variants": {
            "en-US": "Auto Collect Gems"
          }
        },
        "order": 2,
        "targetId": "test-game.gem-extractor",
        "targetType": "generator",
        "trigger": {
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gold",
          "threshold": {
            "kind": "constant",
            "value": 1000
          }
        },
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 5000
        },
        "description": {
          "default": "Toggle mana well when mana is low.",
          "variants": {
            "en-US": "Toggle mana well when mana is low."
          }
        },
        "enabledByDefault": false,
        "id": "test-game.auto-generator-toggle",
        "name": {
          "default": "Generator Toggle",
          "variants": {
            "en-US": "Generator Toggle"
          }
        },
        "order": 5,
        "targetId": "test-game.mana-well",
        "targetType": "generator",
        "trigger": {
          "comparator": "lte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.mana",
          "threshold": {
            "kind": "constant",
            "value": 100
          }
        },
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "description": {
          "default": "Automatically purchase gold mines every 5 seconds.",
          "variants": {
            "en-US": "Automatically purchase gold mines every 5 seconds."
          }
        },
        "enabledByDefault": true,
        "id": "test-game.auto-gold-mine",
        "name": {
          "default": "Auto Gold Mine",
          "variants": {
            "en-US": "Auto Gold Mine"
          }
        },
        "order": 1,
        "targetCount": {
          "kind": "constant",
          "value": 1
        },
        "targetId": "test-game.gold-mine",
        "targetType": "purchaseGenerator",
        "trigger": {
          "interval": {
            "kind": "constant",
            "value": 5000
          },
          "kind": "interval"
        },
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "description": {
          "default": "Automatically prestige when ready.",
          "variants": {
            "en-US": "Automatically prestige when ready."
          }
        },
        "enabledByDefault": false,
        "id": "test-game.auto-prestige",
        "name": {
          "default": "Auto Prestige",
          "variants": {
            "en-US": "Auto Prestige"
          }
        },
        "order": 4,
        "systemTargetId": "offline-catchup",
        "targetType": "system",
        "trigger": {
          "eventId": "test-game:prestige-ready",
          "kind": "event"
        },
        "unlockCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "test-game.ascension"
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 15000
        },
        "description": {
          "default": "Purchase upgrades when the command queue is empty.",
          "variants": {
            "en-US": "Purchase upgrades when the command queue is empty."
          }
        },
        "enabledByDefault": false,
        "id": "test-game.auto-upgrade",
        "name": {
          "default": "Auto Upgrade",
          "variants": {
            "en-US": "Auto Upgrade"
          }
        },
        "order": 3,
        "targetId": "test-game.gold-boost",
        "targetType": "upgrade",
        "trigger": {
          "kind": "commandQueueEmpty"
        },
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "description": {
          "default": "Automation with formula-based interval.",
          "variants": {
            "en-US": "Automation with formula-based interval."
          }
        },
        "enabledByDefault": false,
        "id": "test-game.formula-cooldown-auto",
        "name": {
          "default": "Formula Cooldown Auto",
          "variants": {
            "en-US": "Formula Cooldown Auto"
          }
        },
        "order": 6,
        "resourceCost": {
          "rate": {
            "kind": "constant",
            "value": 1
          },
          "resourceId": "test-game.auto-tokens"
        },
        "targetCount": {
          "kind": "constant",
          "value": 1
        },
        "targetId": "test-game.gem-extractor",
        "targetType": "purchaseGenerator",
        "trigger": {
          "interval": {
            "expression": {
              "kind": "binary",
              "left": {
                "kind": "literal",
                "value": 10000
              },
              "op": "sub",
              "right": {
                "kind": "binary",
                "left": {
                  "kind": "literal",
                  "value": 100
                },
                "op": "mul",
                "right": {
                  "kind": "ref",
                  "target": {
                    "id": "test-game.gold-mine",
                    "type": "generator"
                  }
                }
              }
            },
            "kind": "expression"
          },
          "kind": "interval"
        },
        "unlockCondition": {
          "conditions": [
            {
              "flagId": "test-game:automation-enabled",
              "kind": "flag"
            },
            {
              "comparator": "gte",
              "generatorId": "test-game.auto-factory",
              "kind": "generatorLevel",
              "level": {
                "kind": "constant",
                "value": 1
              }
            }
          ],
          "kind": "allOf"
        }
      }
    ],
    "entities": [
      {
        "description": {
          "default": "A passive item that provides bonuses.",
          "variants": {
            "en-US": "A passive item that provides bonuses."
          }
        },
        "id": "test-game.artifact",
        "name": {
          "default": "Artifact",
          "variants": {
            "en-US": "Artifact"
          }
        },
        "startCount": 0,
        "stats": [
          {
            "baseValue": {
              "kind": "constant",
              "value": 1.1
            },
            "id": "test-game.artifact.bonus",
            "name": {
              "default": "Bonus Multiplier",
              "variants": {
                "en-US": "Bonus Multiplier"
              }
            }
          }
        ],
        "tags": [],
        "trackInstances": false,
        "unlocked": false,
        "visible": true
      },
      {
        "description": {
          "default": "A powerful unit with customizable stats for missions.",
          "variants": {
            "en-US": "A powerful unit with customizable stats for missions."
          }
        },
        "id": "test-game.hero",
        "maxCount": {
          "kind": "constant",
          "value": 5
        },
        "name": {
          "default": "Hero",
          "variants": {
            "en-US": "Hero"
          }
        },
        "progression": {
          "levelFormula": {
            "base": 100,
            "growth": 1.5,
            "kind": "exponential"
          },
          "maxLevel": 50,
          "statGrowth": {}
        },
        "startCount": 0,
        "stats": [
          {
            "baseValue": {
              "kind": "constant",
              "value": 10
            },
            "id": "test-game.hero.power",
            "name": {
              "default": "Power",
              "variants": {
                "en-US": "Power"
              }
            }
          },
          {
            "baseValue": {
              "kind": "constant",
              "value": 5
            },
            "id": "test-game.hero.speed",
            "name": {
              "default": "Speed",
              "variants": {
                "en-US": "Speed"
              }
            }
          },
          {
            "baseValue": {
              "kind": "constant",
              "value": 1
            },
            "id": "test-game.hero.luck",
            "name": {
              "default": "Luck",
              "variants": {
                "en-US": "Luck"
              }
            }
          }
        ],
        "tags": [],
        "trackInstances": true,
        "unlocked": false,
        "visible": true
      },
      {
        "description": {
          "default": "A basic unit for production tasks.",
          "variants": {
            "en-US": "A basic unit for production tasks."
          }
        },
        "id": "test-game.worker",
        "maxCount": {
          "kind": "constant",
          "value": 10
        },
        "name": {
          "default": "Worker",
          "variants": {
            "en-US": "Worker"
          }
        },
        "progression": {
          "levelFormula": {
            "base": 50,
            "kind": "linear",
            "slope": 25
          },
          "maxLevel": 20,
          "statGrowth": {}
        },
        "startCount": 0,
        "stats": [
          {
            "baseValue": {
              "kind": "constant",
              "value": 1
            },
            "id": "test-game.worker.efficiency",
            "name": {
              "default": "Efficiency",
              "variants": {
                "en-US": "Efficiency"
              }
            }
          },
          {
            "baseValue": {
              "kind": "constant",
              "value": 100
            },
            "id": "test-game.worker.stamina",
            "name": {
              "default": "Stamina",
              "variants": {
                "en-US": "Stamina"
              }
            }
          }
        ],
        "tags": [],
        "trackInstances": true,
        "unlocked": false,
        "visible": true
      }
    ],
    "generators": [
      {
        "baseUnlock": {
          "kind": "always"
        },
        "consumes": [],
        "effects": [],
        "id": "test-game.gold-mine",
        "initialLevel": 0,
        "maxLevel": 50,
        "name": {
          "default": "Gold Mine",
          "variants": {
            "en-US": "Gold Mine"
          }
        },
        "order": 1,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "test-game.gold"
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
          "currencyId": "test-game.gold",
          "maxBulk": 10
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "amount": {
            "kind": "constant",
            "value": 500
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gold"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 2
            },
            "resourceId": "test-game.gold"
          }
        ],
        "effects": [],
        "id": "test-game.gem-extractor",
        "initialLevel": 0,
        "maxLevel": 40,
        "name": {
          "default": "Gem Extractor",
          "variants": {
            "en-US": "Gem Extractor"
          }
        },
        "order": 2,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.5
            },
            "resourceId": "test-game.gems"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 100,
            "kind": "linear",
            "slope": 25
          },
          "costMultiplier": 100,
          "currencyId": "test-game.gold",
          "maxBulk": 5
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "comparator": "gte",
          "generatorId": "test-game.gold-mine",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 5
          }
        },
        "consumes": [],
        "effects": [],
        "id": "test-game.mana-well",
        "initialLevel": 0,
        "maxLevel": 35,
        "name": {
          "default": "Mana Well",
          "variants": {
            "en-US": "Mana Well"
          }
        },
        "order": 3,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.8
            },
            "resourceId": "test-game.mana"
          }
        ],
        "purchase": {
          "costCurve": {
            "coefficients": [
              50,
              10,
              0.5
            ],
            "kind": "polynomial"
          },
          "costMultiplier": 50,
          "currencyId": "test-game.gold",
          "maxBulk": 5
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 5000
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gold"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 500
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.mana"
            }
          ],
          "kind": "allOf"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 5
            },
            "resourceId": "test-game.gold"
          },
          {
            "rate": {
              "kind": "constant",
              "value": 2
            },
            "resourceId": "test-game.mana"
          }
        ],
        "effects": [],
        "id": "test-game.essence-refinery",
        "initialLevel": 0,
        "maxLevel": 30,
        "name": {
          "default": "Essence Refinery",
          "variants": {
            "en-US": "Essence Refinery"
          }
        },
        "order": 4,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.2
            },
            "resourceId": "test-game.essence"
          }
        ],
        "purchase": {
          "costCurve": {
            "kind": "piecewise",
            "pieces": [
              {
                "formula": {
                  "base": 1,
                  "growth": 1.15,
                  "kind": "exponential"
                },
                "untilLevel": 10
              },
              {
                "formula": {
                  "base": 3,
                  "growth": 1.12,
                  "kind": "exponential"
                }
              }
            ]
          },
          "costMultiplier": 500,
          "currencyId": "test-game.gold",
          "maxBulk": 3
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "test-game.gems"
          }
        ],
        "effects": [],
        "id": "test-game.auto-factory",
        "initialLevel": 0,
        "maxLevel": 25,
        "name": {
          "default": "Automation Factory",
          "variants": {
            "en-US": "Automation Factory"
          }
        },
        "order": 5,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.1
            },
            "resourceId": "test-game.auto-tokens"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 50,
            "growth": 1.25,
            "kind": "exponential"
          },
          "costMultiplier": 50,
          "currencyId": "test-game.gems",
          "maxBulk": 25
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "kind": "upgradeOwned",
          "requiredPurchases": 1,
          "upgradeId": "test-game.dark-matter-unlock"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "test-game.essence"
          }
        ],
        "effects": [],
        "id": "test-game.dark-matter-harvester",
        "initialLevel": 0,
        "maxLevel": 20,
        "name": {
          "default": "Dark Matter Harvester",
          "variants": {
            "en-US": "Dark Matter Harvester"
          }
        },
        "order": 6,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.05
            },
            "resourceId": "test-game.dark-matter"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 100,
            "growth": 1.3,
            "kind": "exponential"
          },
          "costMultiplier": 100,
          "currencyId": "test-game.essence",
          "maxBulk": 5
        },
        "tags": []
      },
      {
        "baseUnlock": {
          "kind": "prestigeCompleted",
          "prestigeLayerId": "test-game.ascension"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.5
            },
            "resourceId": "test-game.dark-matter"
          }
        ],
        "effects": [],
        "id": "test-game.prestige-reactor",
        "initialLevel": 0,
        "maxLevel": 15,
        "name": {
          "default": "Prestige Reactor",
          "variants": {
            "en-US": "Prestige Reactor"
          }
        },
        "order": 7,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.1
            },
            "resourceId": "test-game.prestige-points"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 10,
            "growth": 1.5,
            "kind": "exponential"
          },
          "costMultiplier": 10,
          "currencyId": "test-game.prestige-points",
          "maxBulk": 3
        },
        "tags": [],
        "visibilityCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "test-game.ascension"
        }
      },
      {
        "baseUnlock": {
          "conditions": [
            {
              "kind": "prestigeCompleted",
              "prestigeLayerId": "test-game.omega"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 100
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.prestige-points"
            }
          ],
          "kind": "allOf"
        },
        "consumes": [
          {
            "rate": {
              "kind": "constant",
              "value": 5
            },
            "resourceId": "test-game.prestige-points"
          }
        ],
        "effects": [],
        "id": "test-game.omega-forge",
        "initialLevel": 0,
        "maxLevel": 10,
        "name": {
          "default": "Omega Forge",
          "variants": {
            "en-US": "Omega Forge"
          }
        },
        "order": 8,
        "produces": [
          {
            "rate": {
              "kind": "constant",
              "value": 0.01
            },
            "resourceId": "test-game.omega-points"
          }
        ],
        "purchase": {
          "costCurve": {
            "base": 100,
            "growth": 2,
            "kind": "exponential"
          },
          "costMultiplier": 100,
          "currencyId": "test-game.prestige-points",
          "maxBulk": 2
        },
        "tags": [],
        "visibilityCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "test-game.omega"
        }
      }
    ],
    "metrics": [
      {
        "attributes": [],
        "description": {
          "default": "Number of times automations have triggered.",
          "variants": {
            "en-US": "Number of times automations have triggered."
          }
        },
        "id": "test-game.automation-triggers",
        "kind": "counter",
        "name": {
          "default": "Automation Triggers",
          "variants": {
            "en-US": "Automation Triggers"
          }
        },
        "source": {
          "kind": "runtime"
        },
        "unit": "triggers"
      },
      {
        "attributes": [],
        "description": {
          "default": "Current gold production per second.",
          "variants": {
            "en-US": "Current gold production per second."
          }
        },
        "id": "test-game.current-dps",
        "kind": "gauge",
        "name": {
          "default": "Current DPS",
          "variants": {
            "en-US": "Current DPS"
          }
        },
        "source": {
          "kind": "content"
        },
        "unit": "gold/s"
      },
      {
        "aggregation": "distribution",
        "attributes": [],
        "description": {
          "default": "Distribution of mission completion times.",
          "variants": {
            "en-US": "Distribution of mission completion times."
          }
        },
        "id": "test-game.mission-duration",
        "kind": "histogram",
        "name": {
          "default": "Mission Duration",
          "variants": {
            "en-US": "Mission Duration"
          }
        },
        "source": {
          "kind": "content"
        },
        "unit": "ms"
      },
      {
        "attributes": [],
        "description": {
          "default": "Total number of prestiges performed.",
          "variants": {
            "en-US": "Total number of prestiges performed."
          }
        },
        "id": "test-game.prestige-count",
        "kind": "counter",
        "name": {
          "default": "Total Prestiges",
          "variants": {
            "en-US": "Total Prestiges"
          }
        },
        "source": {
          "kind": "runtime"
        },
        "unit": "prestiges"
      },
      {
        "attributes": [],
        "description": {
          "default": "Cumulative gold earned across all runs.",
          "variants": {
            "en-US": "Cumulative gold earned across all runs."
          }
        },
        "id": "test-game.total-gold-earned",
        "kind": "counter",
        "name": {
          "default": "Total Gold Earned",
          "variants": {
            "en-US": "Total Gold Earned"
          }
        },
        "source": {
          "kind": "runtime"
        },
        "unit": "gold"
      }
    ],
    "prestigeLayers": [
      {
        "id": "test-game.ascension",
        "name": {
          "default": "Ascension",
          "variants": {
            "en-US": "Ascension"
          }
        },
        "order": 1,
        "resetTargets": [
          "test-game.auto-tokens",
          "test-game.dark-matter",
          "test-game.essence",
          "test-game.gems",
          "test-game.gold",
          "test-game.mana"
        ],
        "retention": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "kind": "resource",
            "resourceId": "test-game.prestige-points"
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
                        "kind": "ref",
                        "target": {
                          "id": "test-game.essence",
                          "type": "resource"
                        }
                      },
                      "op": "add",
                      "right": {
                        "kind": "binary",
                        "left": {
                          "kind": "literal",
                          "value": 10
                        },
                        "op": "mul",
                        "right": {
                          "kind": "ref",
                          "target": {
                            "id": "test-game.dark-matter",
                            "type": "resource"
                          }
                        }
                      }
                    },
                    "op": "div",
                    "right": {
                      "kind": "literal",
                      "value": 1000
                    }
                  }
                },
                {
                  "kind": "literal",
                  "value": 1
                },
                {
                  "kind": "literal",
                  "value": 10000
                }
              ],
              "kind": "call",
              "name": "clamp"
            },
            "kind": "expression"
          },
          "resourceId": "test-game.prestige-points"
        },
        "summary": {
          "default": "Reset tier 0-1 resources and generators for prestige points.",
          "variants": {
            "en-US": "Reset tier 0-1 resources and generators for prestige points."
          }
        },
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 10000
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.essence"
            },
            {
              "comparator": "gte",
              "generatorId": "test-game.gold-mine",
              "kind": "generatorLevel",
              "level": {
                "kind": "constant",
                "value": 20
              }
            }
          ],
          "kind": "allOf"
        }
      },
      {
        "id": "test-game.omega",
        "name": {
          "default": "Omega",
          "variants": {
            "en-US": "Omega"
          }
        },
        "order": 2,
        "resetTargets": [
          "test-game.auto-tokens",
          "test-game.dark-matter",
          "test-game.essence",
          "test-game.gems",
          "test-game.gold",
          "test-game.mana",
          "test-game.prestige-points"
        ],
        "retention": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "kind": "resource",
            "resourceId": "test-game.omega-points"
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
                      "kind": "ref",
                      "target": {
                        "id": "test-game.prestige-points",
                        "type": "resource"
                      }
                    },
                    "op": "div",
                    "right": {
                      "kind": "literal",
                      "value": 100
                    }
                  }
                },
                {
                  "kind": "literal",
                  "value": 1
                },
                {
                  "kind": "literal",
                  "value": 1000
                }
              ],
              "kind": "call",
              "name": "clamp"
            },
            "kind": "expression"
          },
          "resourceId": "test-game.omega-points"
        },
        "summary": {
          "default": "Reset everything including first prestige for omega points.",
          "variants": {
            "en-US": "Reset everything including first prestige for omega points."
          }
        },
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 1000
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.prestige-points"
            },
            {
              "comparator": "gte",
              "count": 5,
              "kind": "prestigeCountThreshold",
              "prestigeLayerId": "test-game.ascension"
            }
          ],
          "kind": "allOf"
        }
      }
    ],
    "resources": [
      {
        "capacity": null,
        "category": "primary",
        "economyClassification": "soft",
        "id": "test-game.gold",
        "name": {
          "default": "Gold",
          "variants": {
            "en-US": "Gold"
          }
        },
        "order": 1,
        "startAmount": 100,
        "tags": [],
        "tier": 1,
        "unlocked": true,
        "visible": true
      },
      {
        "capacity": null,
        "category": "currency",
        "economyClassification": "hard",
        "id": "test-game.gems",
        "name": {
          "default": "Gems",
          "variants": {
            "en-US": "Gems"
          }
        },
        "order": 2,
        "startAmount": 0,
        "tags": [],
        "tier": 1,
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 500
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gold"
        },
        "unlocked": false,
        "visible": true
      },
      {
        "capacity": 1000,
        "category": "primary",
        "economyClassification": "soft",
        "id": "test-game.mana",
        "name": {
          "default": "Mana",
          "variants": {
            "en-US": "Mana"
          }
        },
        "order": 3,
        "startAmount": 0,
        "tags": [],
        "tier": 1,
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "test-game.gold-mine",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 5
          }
        },
        "unlocked": false,
        "visible": true
      },
      {
        "capacity": null,
        "category": "primary",
        "economyClassification": "soft",
        "id": "test-game.essence",
        "name": {
          "default": "Essence",
          "variants": {
            "en-US": "Essence"
          }
        },
        "order": 4,
        "startAmount": 0,
        "tags": [],
        "tier": 2,
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 5000
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gold"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 500
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.mana"
            }
          ],
          "kind": "allOf"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "primary",
        "dirtyTolerance": 0.001,
        "economyClassification": "soft",
        "id": "test-game.dark-matter",
        "name": {
          "default": "Dark Matter",
          "variants": {
            "en-US": "Dark Matter"
          }
        },
        "order": 5,
        "startAmount": 0,
        "tags": [],
        "tier": 2,
        "unlockCondition": {
          "kind": "upgradeOwned",
          "requiredPurchases": 1,
          "upgradeId": "test-game.dark-matter-unlock"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "automation",
        "economyClassification": "soft",
        "id": "test-game.auto-tokens",
        "name": {
          "default": "Automation Tokens",
          "variants": {
            "en-US": "Automation Tokens"
          }
        },
        "order": 6,
        "startAmount": 0,
        "tags": [],
        "tier": 1,
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        },
        "unlocked": false,
        "visible": true
      },
      {
        "capacity": null,
        "category": "prestige",
        "economyClassification": "soft",
        "id": "test-game.prestige-points",
        "name": {
          "default": "Prestige Points",
          "variants": {
            "en-US": "Prestige Points"
          }
        },
        "order": 7,
        "prestige": {
          "layerId": "test-game.ascension",
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
          "prestigeLayerId": "test-game.ascension"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "prestige",
        "economyClassification": "soft",
        "id": "test-game.omega-points",
        "name": {
          "default": "Omega Points",
          "variants": {
            "en-US": "Omega Points"
          }
        },
        "order": 8,
        "prestige": {
          "layerId": "test-game.omega",
          "resetRetention": {
            "kind": "constant",
            "value": 1
          }
        },
        "startAmount": 0,
        "tags": [],
        "tier": 4,
        "unlockCondition": {
          "kind": "prestigeUnlocked",
          "prestigeLayerId": "test-game.omega"
        },
        "unlocked": false,
        "visible": false
      },
      {
        "capacity": null,
        "category": "misc",
        "economyClassification": "soft",
        "id": "test-game.ascension-prestige-count",
        "name": {
          "default": "Ascension Count",
          "variants": {
            "en-US": "Ascension Count"
          }
        },
        "order": 9,
        "startAmount": 0,
        "tags": [],
        "tier": 3,
        "unlocked": true,
        "visible": false
      },
      {
        "capacity": null,
        "category": "misc",
        "economyClassification": "soft",
        "id": "test-game.omega-prestige-count",
        "name": {
          "default": "Omega Count",
          "variants": {
            "en-US": "Omega Count"
          }
        },
        "order": 10,
        "startAmount": 0,
        "tags": [],
        "tier": 4,
        "unlocked": true,
        "visible": false
      }
    ],
    "runtimeEvents": [],
    "transforms": [
      {
        "description": {
          "default": "Process mana into gems over time.",
          "variants": {
            "en-US": "Process mana into gems over time."
          }
        },
        "duration": {
          "kind": "constant",
          "value": 30000
        },
        "id": "test-game.batch-production",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 50
            },
            "resourceId": "test-game.mana"
          },
          {
            "amount": {
              "kind": "constant",
              "value": 200
            },
            "resourceId": "test-game.gold"
          }
        ],
        "mode": "batch",
        "name": {
          "default": "Batch Production",
          "variants": {
            "en-US": "Batch Production"
          }
        },
        "order": 2,
        "outputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 5
            },
            "resourceId": "test-game.gems"
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
            "value": 100
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.mana"
        }
      },
      {
        "description": {
          "default": "Send heroes on an expedition for rewards.",
          "variants": {
            "en-US": "Send heroes on an expedition for rewards."
          }
        },
        "duration": {
          "kind": "constant",
          "value": 120000
        },
        "entityRequirements": [
          {
            "count": {
              "kind": "constant",
              "value": 1
            },
            "entityId": "test-game.hero",
            "returnOnComplete": true
          }
        ],
        "id": "test-game.expedition",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 500
            },
            "resourceId": "test-game.gold"
          }
        ],
        "mode": "mission",
        "name": {
          "default": "Expedition",
          "variants": {
            "en-US": "Expedition"
          }
        },
        "order": 3,
        "outcomes": {
          "failure": {
            "outputs": [
              {
                "amount": {
                  "kind": "constant",
                  "value": 100
                },
                "resourceId": "test-game.gold"
              }
            ]
          },
          "success": {
            "outputs": [
              {
                "amount": {
                  "kind": "constant",
                  "value": 20
                },
                "resourceId": "test-game.gems"
              },
              {
                "amount": {
                  "kind": "constant",
                  "value": 5
                },
                "resourceId": "test-game.essence"
              }
            ]
          }
        },
        "outputs": [],
        "tags": [],
        "trigger": {
          "kind": "manual"
        },
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "test-game.gold-mine",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 10
          }
        }
      },
      {
        "cooldown": {
          "kind": "constant",
          "value": 5000
        },
        "description": {
          "default": "Convert gold into essence instantly.",
          "variants": {
            "en-US": "Convert gold into essence instantly."
          }
        },
        "id": "test-game.refine-essence",
        "inputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 100
            },
            "resourceId": "test-game.gold"
          }
        ],
        "mode": "instant",
        "name": {
          "default": "Refine Essence",
          "variants": {
            "en-US": "Refine Essence"
          }
        },
        "order": 1,
        "outputs": [
          {
            "amount": {
              "kind": "constant",
              "value": 1
            },
            "resourceId": "test-game.essence"
          }
        ],
        "tags": [],
        "trigger": {
          "kind": "manual"
        },
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 5000
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gold"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 500
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.mana"
            }
          ],
          "kind": "allOf"
        }
      }
    ],
    "upgrades": [
      {
        "category": "global",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 200,
          "currencyId": "test-game.gold"
        },
        "description": {
          "default": "Increases all gold production by 25%.",
          "variants": {
            "en-US": "Increases all gold production by 25%."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceRate",
            "operation": "multiply",
            "resourceId": "test-game.gold",
            "value": {
              "kind": "constant",
              "value": 1.25
            }
          }
        ],
        "id": "test-game.gold-boost",
        "name": {
          "default": "Gold Boost",
          "variants": {
            "en-US": "Gold Boost"
          }
        },
        "order": 1,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.gold",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 100
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gold"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 50,
          "currencyId": "test-game.gems"
        },
        "description": {
          "default": "Reduces gem extractor costs by 10%.",
          "variants": {
            "en-US": "Reduces gem extractor costs by 10%."
          }
        },
        "effects": [
          {
            "generatorId": "test-game.gem-extractor",
            "kind": "modifyGeneratorCost",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 0.9
            }
          }
        ],
        "id": "test-game.gem-efficiency",
        "name": {
          "default": "Gem Efficiency",
          "variants": {
            "en-US": "Gem Efficiency"
          }
        },
        "order": 2,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.gem-extractor",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "test-game.gem-extractor",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 1
          }
        }
      },
      {
        "category": "automation",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 10,
          "currencyId": "test-game.auto-tokens"
        },
        "description": {
          "default": "Reduces automation cooldowns by 15%.",
          "variants": {
            "en-US": "Reduces automation cooldowns by 15%."
          }
        },
        "effects": [
          {
            "flagId": "test-game:fast-automation",
            "kind": "grantFlag",
            "value": true
          }
        ],
        "id": "test-game.auto-speed",
        "name": {
          "default": "Automation Speed",
          "variants": {
            "en-US": "Automation Speed"
          }
        },
        "order": 3,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "kind": "global"
          }
        ],
        "unlockCondition": {
          "flagId": "test-game:automation-enabled",
          "kind": "flag"
        }
      },
      {
        "category": "prestige",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 5,
          "currencyId": "test-game.prestige-points"
        },
        "description": {
          "default": "Increases prestige rewards by 50%.",
          "variants": {
            "en-US": "Increases prestige rewards by 50%."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceRate",
            "operation": "multiply",
            "resourceId": "test-game.prestige-points",
            "value": {
              "kind": "constant",
              "value": 1.5
            }
          }
        ],
        "id": "test-game.prestige-multiplier",
        "name": {
          "default": "Prestige Multiplier",
          "variants": {
            "en-US": "Prestige Multiplier"
          }
        },
        "order": 4,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.ascension",
            "kind": "prestigeLayer"
          }
        ],
        "unlockCondition": {
          "kind": "prestigeCompleted",
          "prestigeLayerId": "test-game.ascension"
        }
      },
      {
        "category": "global",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 1000,
          "currencyId": "test-game.gold"
        },
        "description": {
          "default": "Increases all production by 10%.",
          "variants": {
            "en-US": "Increases all production by 10%."
          }
        },
        "effects": [
          {
            "generatorId": "test-game.gold-mine",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.1
            }
          },
          {
            "generatorId": "test-game.gem-extractor",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.1
            }
          },
          {
            "generatorId": "test-game.mana-well",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 1.1
            }
          }
        ],
        "id": "test-game.global-multiplier",
        "name": {
          "default": "Global Multiplier",
          "variants": {
            "en-US": "Global Multiplier"
          }
        },
        "order": 5,
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
            "value": 500
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gold"
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 100,
          "currencyId": "test-game.mana"
        },
        "description": {
          "default": "Increases mana capacity by 500.",
          "variants": {
            "en-US": "Increases mana capacity by 500."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceCapacity",
            "operation": "add",
            "resourceId": "test-game.mana",
            "value": {
              "kind": "constant",
              "value": 500
            }
          }
        ],
        "id": "test-game.mana-capacity",
        "name": {
          "default": "Mana Capacity",
          "variants": {
            "en-US": "Mana Capacity"
          }
        },
        "order": 6,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.mana",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 800
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.mana"
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 50,
          "currencyId": "test-game.essence"
        },
        "description": {
          "default": "One-time boost to essence production.",
          "variants": {
            "en-US": "One-time boost to essence production."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceRate",
            "operation": "multiply",
            "resourceId": "test-game.essence",
            "value": {
              "kind": "constant",
              "value": 1.5
            }
          }
        ],
        "id": "test-game.essence-rate-1",
        "name": {
          "default": "Essence Rate I",
          "variants": {
            "en-US": "Essence Rate I"
          }
        },
        "order": 7,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.essence",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 25
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.essence"
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "base": 1,
            "kind": "linear",
            "slope": 0.5
          },
          "costMultiplier": 100,
          "currencyId": "test-game.essence"
        },
        "description": {
          "default": "Repeatable essence boost (max 10).",
          "variants": {
            "en-US": "Repeatable essence boost (max 10)."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceRate",
            "operation": "multiply",
            "resourceId": "test-game.essence",
            "value": {
              "kind": "constant",
              "value": 1.1
            }
          }
        ],
        "id": "test-game.essence-rate-2",
        "name": {
          "default": "Essence Rate II",
          "variants": {
            "en-US": "Essence Rate II"
          }
        },
        "order": 8,
        "prerequisites": [
          {
            "kind": "upgradeOwned",
            "requiredPurchases": 1,
            "upgradeId": "test-game.essence-rate-1"
          }
        ],
        "repeatable": {
          "costCurve": {
            "base": 1,
            "growth": 1.2,
            "kind": "exponential"
          },
          "maxPurchases": 10
        },
        "tags": [],
        "targets": [
          {
            "id": "test-game.essence",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 100
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.essence"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 5000,
          "currencyId": "test-game.gold"
        },
        "description": {
          "default": "A powerful upgrade requiring multiple currencies.",
          "variants": {
            "en-US": "A powerful upgrade requiring multiple currencies."
          }
        },
        "effects": [
          {
            "generatorId": "test-game.gold-mine",
            "kind": "modifyGeneratorRate",
            "operation": "multiply",
            "value": {
              "kind": "constant",
              "value": 2
            }
          }
        ],
        "id": "test-game.multi-currency-upgrade",
        "name": {
          "default": "Multi-Currency Boost",
          "variants": {
            "en-US": "Multi-Currency Boost"
          }
        },
        "order": 9,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.gold-mine",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "conditions": [
            {
              "amount": {
                "kind": "constant",
                "value": 2500
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gold"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 100
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gems"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 250
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.mana"
            }
          ],
          "kind": "allOf"
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 500,
          "currencyId": "test-game.essence"
        },
        "description": {
          "default": "Unlocks dark matter production.",
          "variants": {
            "en-US": "Unlocks dark matter production."
          }
        },
        "effects": [
          {
            "kind": "unlockResource",
            "resourceId": "test-game.dark-matter"
          },
          {
            "eventId": "test-game:milestone-reached",
            "kind": "emitEvent"
          }
        ],
        "id": "test-game.dark-matter-unlock",
        "name": {
          "default": "Dark Matter Unlock",
          "variants": {
            "en-US": "Dark Matter Unlock"
          }
        },
        "order": 10,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.dark-matter",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 250
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.essence"
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 500,
          "currencyId": "test-game.gold"
        },
        "description": {
          "default": "Uses expression formula for dynamic effect scaling.",
          "variants": {
            "en-US": "Uses expression formula for dynamic effect scaling."
          }
        },
        "effects": [
          {
            "kind": "modifyResourceRate",
            "operation": "multiply",
            "resourceId": "test-game.gold",
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
                      "id": "test-game.gold-mine",
                      "type": "generator"
                    }
                  }
                }
              },
              "kind": "expression"
            }
          }
        ],
        "id": "test-game.expression-upgrade",
        "name": {
          "default": "Expression Upgrade",
          "variants": {
            "en-US": "Expression Upgrade"
          }
        },
        "order": 11,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.gold",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "test-game.gold-mine",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 10
          }
        }
      },
      {
        "category": "automation",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 100,
          "currencyId": "test-game.gems"
        },
        "description": {
          "default": "Unlocks the automation system.",
          "variants": {
            "en-US": "Unlocks the automation system."
          }
        },
        "effects": [
          {
            "flagId": "test-game:automation-enabled",
            "kind": "grantFlag",
            "value": true
          }
        ],
        "id": "test-game.automation-unlock",
        "name": {
          "default": "Automation Unlock",
          "variants": {
            "en-US": "Automation Unlock"
          }
        },
        "order": 12,
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
            "value": 50
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.gems"
        }
      },
      {
        "category": "generator",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 300,
          "currencyId": "test-game.gold"
        },
        "description": {
          "default": "Reduces gold mine consumption.",
          "variants": {
            "en-US": "Reduces gold mine consumption."
          }
        },
        "effects": [
          {
            "generatorId": "test-game.essence-refinery",
            "kind": "modifyGeneratorConsumption",
            "operation": "multiply",
            "resourceId": "test-game.gold",
            "value": {
              "kind": "constant",
              "value": 0.8
            }
          }
        ],
        "id": "test-game.mine-efficiency",
        "name": {
          "default": "Mine Efficiency",
          "variants": {
            "en-US": "Mine Efficiency"
          }
        },
        "order": 13,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.gold-mine",
            "kind": "generator"
          }
        ],
        "unlockCondition": {
          "comparator": "gte",
          "generatorId": "test-game.gold-mine",
          "kind": "generatorLevel",
          "level": {
            "kind": "constant",
            "value": 15
          }
        }
      },
      {
        "category": "resource",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 10,
          "currencyId": "test-game.dark-matter"
        },
        "description": {
          "default": "Increases dark matter precision.",
          "variants": {
            "en-US": "Increases dark matter precision."
          }
        },
        "effects": [
          {
            "kind": "alterDirtyTolerance",
            "operation": "multiply",
            "resourceId": "test-game.dark-matter",
            "value": {
              "kind": "constant",
              "value": 0.1
            }
          }
        ],
        "id": "test-game.dirty-tolerance-boost",
        "name": {
          "default": "Precision Engineering",
          "variants": {
            "en-US": "Precision Engineering"
          }
        },
        "order": 14,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "id": "test-game.dark-matter",
            "kind": "resource"
          }
        ],
        "unlockCondition": {
          "amount": {
            "kind": "constant",
            "value": 5
          },
          "comparator": "gte",
          "kind": "resourceThreshold",
          "resourceId": "test-game.dark-matter"
        }
      },
      {
        "category": "automation",
        "cost": {
          "costCurve": {
            "kind": "constant",
            "value": 1
          },
          "costMultiplier": 500,
          "currencyId": "test-game.gems"
        },
        "description": {
          "default": "Grants a premium automation.",
          "variants": {
            "en-US": "Grants a premium automation."
          }
        },
        "effects": [
          {
            "automationId": "test-game.auto-prestige",
            "kind": "grantAutomation"
          }
        ],
        "id": "test-game.grant-automation",
        "name": {
          "default": "Premium Automation",
          "variants": {
            "en-US": "Premium Automation"
          }
        },
        "order": 15,
        "prerequisites": [],
        "tags": [],
        "targets": [
          {
            "kind": "global"
          }
        ],
        "unlockCondition": {
          "conditions": [
            {
              "flagId": "test-game:automation-enabled",
              "kind": "flag"
            },
            {
              "amount": {
                "kind": "constant",
                "value": 250
              },
              "comparator": "gte",
              "kind": "resourceThreshold",
              "resourceId": "test-game.gems"
            }
          ],
          "kind": "allOf"
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

export const PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME = rehydrateNormalizedPack(serialized, {
  verifyDigest: shouldVerifyDigest,
});
export const PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_DIGEST = serialized.digest;
export const PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_ARTIFACT_HASH = serialized.artifactHash;
export const PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_INDICES = createModuleIndices(PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME);
export const PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_SUMMARY = Object.freeze({
  slug: serialized.metadata.id,
  version: serialized.metadata.version,
  digest: serialized.digest,
  artifactHash: serialized.artifactHash,
  warningCount: serialized.warnings.length,
  resourceIds: serialized.modules.resources.map((resource) => resource.id),
  entityIds: serialized.modules.entities.map((entity) => entity.id),
});

