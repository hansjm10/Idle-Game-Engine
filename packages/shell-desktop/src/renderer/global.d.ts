import type { IdleEngineApi } from '../ipc.js';

declare global {
  interface Window {
    idleEngine: IdleEngineApi;
  }
}

export {};

