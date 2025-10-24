export interface ModifierVector {
  additive: number;
  multiplicative: number;
  exponential: number;
}

const DEFAULT_VECTOR: Readonly<ModifierVector> = Object.freeze({
  additive: 0,
  multiplicative: 1,
  exponential: 1,
});

export class GeneratorModifierLedger {
  private readonly entries = new Map<string, ModifierVector>();

  reset(): void {
    this.entries.clear();
  }

  applyAdditive(generatorId: string, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error('Modifier ledger additive value must be finite.');
    }
    const entry = this.require(generatorId);
    entry.additive += value;
  }

  applyMultiplicative(generatorId: string, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error('Modifier ledger multiplicative value must be finite.');
    }
    const entry = this.require(generatorId);
    entry.multiplicative *= value;
  }

  applyExponential(generatorId: string, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error('Modifier ledger exponential value must be finite.');
    }
    const entry = this.require(generatorId);
    entry.exponential *= value;
  }

  get(generatorId: string): ModifierVector {
    return this.entries.get(generatorId) ?? DEFAULT_VECTOR;
  }

  private require(generatorId: string): ModifierVector {
    let entry = this.entries.get(generatorId);
    if (!entry) {
      entry = {
        additive: 0,
        multiplicative: 1,
        exponential: 1,
      };
      this.entries.set(generatorId, entry);
    }
    return entry;
  }
}

