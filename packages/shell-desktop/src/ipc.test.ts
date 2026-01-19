import { describe, expect, it } from 'vitest';

import { IDLE_ENGINE_API_KEY, IPC_CHANNELS } from './ipc.js';

describe('shell-desktop IPC contract', () => {
  it('uses stable, explicit identifiers', () => {
    expect(IDLE_ENGINE_API_KEY).toBe('idleEngine');
    expect(IPC_CHANNELS.ping).toBe('idle-engine:ping');
    expect(IPC_CHANNELS.controlEvent).toBe('idle-engine:control-event');
    expect(IPC_CHANNELS.frame).toBe('idle-engine:frame');
  });
});
