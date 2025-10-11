const STATE_INCREMENT = 0x6d2b79f5;

let currentSeed: number | undefined;
let rngState: number | undefined;

export function getCurrentRNGSeed(): number | undefined {
  return currentSeed;
}

export function setRNGSeed(seed: number): void {
  const normalized = seed >>> 0;
  currentSeed = normalized;
  rngState = normalized || 0x1;
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
  let t = Math.imul(rngState! ^ (rngState! >>> 15), 1 | rngState!);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
