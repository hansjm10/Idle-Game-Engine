export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
