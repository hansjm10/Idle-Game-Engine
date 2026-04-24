import type { IdleEngineApi } from '../ipc.js';

declare global {
  var idleEngine: IdleEngineApi;

  interface Window {
    idleEngine: IdleEngineApi;
  }
}

export {};
