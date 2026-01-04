const STATE_INCREMENT = 0x6d2b79f5;
const PRD_MAX_ATTEMPTS = 1000;
const PRD_CUMULATIVE_THRESHOLD = 0.9999;
const PRD_SEARCH_ITERATIONS = 20;
const PRD_BASE_RATE_REL_EPSILON = 1e-6;
const PRD_BASE_RATE_ABS_EPSILON = 1e-12;

let currentSeed: number | undefined;
let rngState: number | undefined;

export function getCurrentRNGSeed(): number | undefined {
  return currentSeed;
}

/**
 * Returns the current internal RNG state (position) if seeded.
 */
export function getRNGState(): number | undefined {
  return rngState;
}

export function setRNGSeed(seed: number): void {
  const normalized = seed >>> 0;
  currentSeed = normalized;
  rngState = normalized || 0x1;
}

/**
 * Sets the internal RNG state for restore-and-continue workflows.
 */
export function setRNGState(state: number): void {
  if (!Number.isFinite(state)) {
    throw new Error('RNG state must be a finite number.');
  }
  rngState = state | 0;
}

export function resetRNG(): void {
  currentSeed = undefined;
  rngState = undefined;
}

export function seededRandom(): number {
  if (rngState === undefined) {
    const fallbackSeed = Math.floor(Math.random() * 0xffffffff);
    setRNGSeed(fallbackSeed);
  }

  rngState = (rngState! + STATE_INCREMENT) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const normalizeProbability = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
};

const normalizeNonNegativeInt = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
};

/**
 * Calculate average probability for a given PRD constant.
 */
export function calculatePRDAverageProbability(constant: number): number {
  const normalizedConstant = normalizeProbability(constant);
  if (normalizedConstant === 0 || normalizedConstant === 1) {
    return normalizedConstant;
  }

  const guaranteedAttempt = Math.ceil(1 / normalizedConstant);
  if (guaranteedAttempt > PRD_MAX_ATTEMPTS) {
    // For tiny constants the discrete PRD approaches a continuous linear hazard
    // (Rayleigh distribution), avoiding huge loops for small probabilities.
    return Math.sqrt((2 * normalizedConstant) / Math.PI);
  }

  let expectedAttempts = 0;
  let cumulativeProbability = 0;

  for (let attempt = 1; attempt <= guaranteedAttempt; attempt += 1) {
    const probability =
      attempt === guaranteedAttempt ? 1 : normalizedConstant * attempt;
    const weight = (1 - cumulativeProbability) * probability;
    expectedAttempts += attempt * weight;
    cumulativeProbability += weight;

    if (cumulativeProbability >= PRD_CUMULATIVE_THRESHOLD) {
      break;
    }
  }

  if (expectedAttempts <= 0) {
    return 0;
  }

  return 1 / expectedAttempts;
}

/**
 * Calculate the PRD constant for a given probability.
 * Uses iterative approximation as there's no closed-form solution.
 */
export function calculatePRDConstant(probability: number): number {
  const normalizedProbability = normalizeProbability(probability);
  if (normalizedProbability === 0 || normalizedProbability === 1) {
    return normalizedProbability;
  }

  let low = 0;
  let high = normalizedProbability;

  for (let iteration = 0; iteration < PRD_SEARCH_ITERATIONS; iteration += 1) {
    const mid = (low + high) / 2;
    const actualProbability = calculatePRDAverageProbability(mid);

    if (actualProbability > normalizedProbability) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return (low + high) / 2;
}

export type PRDState = Readonly<{
  readonly attempts: number;
  readonly constant: number;
}>;

export type SerializedPRDRegistryState = Readonly<Record<string, PRDState>>;

export class PseudoRandomDistribution {
  private attempts: number;
  private constant: number;
  private baseProbability: number;
  private readonly random: () => number;

  constructor(baseProbability: number, random: () => number = seededRandom) {
    this.random = random;
    this.baseProbability = normalizeProbability(baseProbability);
    this.constant = calculatePRDConstant(this.baseProbability);
    this.attempts = 0;
  }

  /**
   * Roll for success. Returns true on success, false on failure.
   * Automatically tracks attempt count.
   */
  roll(): boolean {
    this.attempts += 1;
    const threshold = Math.min(1, this.constant * this.attempts);
    const roll = this.random();

    if (roll < threshold) {
      this.attempts = 0;
      return true;
    }

    return false;
  }

  /**
   * Get current probability (for UI display).
   */
  getCurrentProbability(): number {
    return Math.min(1, this.constant * (this.attempts + 1));
  }

  /**
   * Get base (stated) probability.
   */
  getBaseProbability(): number {
    return calculatePRDAverageProbability(this.constant);
  }

  updateBaseProbability(baseProbability: number): void {
    const normalized = normalizeProbability(baseProbability);
    const delta = Math.abs(normalized - this.baseProbability);
    if (delta === 0) {
      return;
    }
    const maxBase = Math.max(normalized, this.baseProbability);
    const threshold =
      maxBase <= PRD_BASE_RATE_ABS_EPSILON
        ? 0
        : Math.max(
            PRD_BASE_RATE_REL_EPSILON * maxBase,
            PRD_BASE_RATE_ABS_EPSILON,
          );
    if (delta <= threshold) {
      return;
    }

    this.baseProbability = normalized;
    this.constant = calculatePRDConstant(normalized);
    this.attempts = 0;
  }

  /**
   * Serialize state for save files.
   */
  getState(): PRDState {
    return {
      attempts: this.attempts,
      constant: this.constant,
    };
  }

  /**
   * Restore from serialized state.
   */
  restore(state: PRDState): void {
    this.constant = normalizeProbability(state.constant);
    this.attempts = normalizeNonNegativeInt(state.attempts);
    this.baseProbability = calculatePRDAverageProbability(this.constant);
  }

  /**
   * Restore from serialized state.
   */
  static fromState(
    state: PRDState,
    random: () => number = seededRandom,
  ): PseudoRandomDistribution {
    const prd = new PseudoRandomDistribution(0, random);
    prd.restore(state);
    return prd;
  }

  /**
   * Reset attempt counter (e.g., for new mission type).
   */
  reset(): void {
    this.attempts = 0;
  }
}

export class PRDRegistry {
  private readonly states = new Map<string, PseudoRandomDistribution>();
  private readonly random: () => number;

  constructor(random: () => number = seededRandom) {
    this.random = random;
  }

  /**
   * Get or create PRD for a mission/ability.
   */
  getOrCreate(id: string, baseProbability: number): PseudoRandomDistribution {
    const existing = this.states.get(id);
    if (existing) {
      existing.updateBaseProbability(baseProbability);
      return existing;
    }

    const created = new PseudoRandomDistribution(baseProbability, this.random);
    this.states.set(id, created);
    return created;
  }

  /**
   * Serialize all PRD states.
   */
  captureState(): SerializedPRDRegistryState {
    const result: Record<string, PRDState> = {};
    for (const [id, prd] of this.states) {
      result[id] = prd.getState();
    }
    return result;
  }

  /**
   * Restore PRD states from save.
   */
  restoreState(states: SerializedPRDRegistryState | undefined): void {
    this.states.clear();
    if (!states) {
      return;
    }
    for (const [id, state] of Object.entries(states)) {
      this.states.set(id, PseudoRandomDistribution.fromState(state, this.random));
    }
  }
}
