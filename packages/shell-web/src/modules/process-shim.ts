import processPolyfill from 'process';

type ProcessShim = typeof processPolyfill;

declare global {
  var process: ProcessShim | undefined;
}

const globalTarget = globalThis as typeof globalThis & {
  process?: ProcessShim;
};

if (typeof globalTarget.process === 'undefined') {
  globalTarget.process = processPolyfill;
}

globalTarget.process.env ??= {};

if (globalTarget.process.env.NODE_ENV === undefined) {
  globalTarget.process.env.NODE_ENV = 'production';
}

if (typeof globalTarget.process.uptime !== 'function') {
  globalTarget.process.uptime = () => performance.now() / 1_000;
}

export {};
