import { describe, expect, it } from 'vitest';

import { EventBus } from './event-bus.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './runtime-event-catalog.js';
import type { RuntimeEventPayload } from './runtime-event.js';

describe('runtime-event-catalog', () => {
  function createBus(): EventBus {
    const bus = new EventBus({ channels: DEFAULT_EVENT_BUS_OPTIONS.channels });
    bus.beginTick(0);
    return bus;
  }

  it('validates resource:threshold-reached payloads', () => {
    const bus = createBus();

    expect(() => {
      bus.publish('resource:threshold-reached', {
        resourceId: '',
        threshold: 10,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }).toThrow('resourceId must be a non-blank string.');

    expect(() => {
      bus.publish('resource:threshold-reached', {
        resourceId: '   ',
        threshold: 10,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }).toThrow('resourceId must be a non-blank string.');

    expect(() => {
      bus.publish('resource:threshold-reached', {
        resourceId: 'res:energy',
        threshold: Number.NaN,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }).toThrow('threshold must be a finite number.');

    expect(() => {
      bus.publish('resource:threshold-reached', {
        resourceId: 'res:energy',
        threshold: 10,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }).not.toThrow();
  });

  it('validates automation:toggled payloads', () => {
    const bus = createBus();

    expect(() => {
      bus.publish('automation:toggled', {
        automationId: '',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>);
    }).toThrow('automationId must be a non-blank string.');

    expect(() => {
      bus.publish('automation:toggled', {
        automationId: '   ',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>);
    }).toThrow('automationId must be a non-blank string.');

    expect(() => {
      bus.publish('automation:toggled', {
        automationId: 'auto:1',
        enabled: 'yes' as any,
      } as RuntimeEventPayload<'automation:toggled'>);
    }).toThrow('enabled must be a boolean.');

    expect(() => {
      bus.publish('automation:toggled', {
        automationId: 'auto:1',
        enabled: false,
      } as RuntimeEventPayload<'automation:toggled'>);
    }).not.toThrow();
  });

  it('validates automation:fired payloads', () => {
    const bus = createBus();
    const validTriggerKind = 'event' as const;

    expect(() => {
      bus.publish('automation:fired', {
        automationId: '',
        triggerKind: validTriggerKind,
        step: 0,
      } as RuntimeEventPayload<'automation:fired'>);
    }).toThrow('automationId must be a non-blank string.');

    expect(() => {
      bus.publish('automation:fired', {
        automationId: 'auto:1',
        triggerKind: '',
        step: 0,
      } as unknown as RuntimeEventPayload<'automation:fired'>);
    }).toThrow('triggerKind must be a non-blank string.');

    expect(() => {
      bus.publish('automation:fired', {
        automationId: 'auto:1',
        triggerKind: '   ',
        step: 0,
      } as unknown as RuntimeEventPayload<'automation:fired'>);
    }).toThrow('triggerKind must be a non-blank string.');

    expect(() => {
      bus.publish('automation:fired', {
        automationId: 'auto:1',
        triggerKind: validTriggerKind,
        step: -1,
      } as RuntimeEventPayload<'automation:fired'>);
    }).toThrow('step must be a non-negative integer.');

    expect(() => {
      bus.publish('automation:fired', {
        automationId: 'auto:1',
        triggerKind: validTriggerKind,
        step: 1.5,
      } as RuntimeEventPayload<'automation:fired'>);
    }).toThrow('step must be a non-negative integer.');

    expect(() => {
      bus.publish('automation:fired', {
        automationId: 'auto:1',
        triggerKind: validTriggerKind,
        step: 1,
      } as RuntimeEventPayload<'automation:fired'>);
    }).not.toThrow();
  });

  it('validates mission:started payloads', () => {
    const bus = createBus();

    expect(() => {
      bus.publish('mission:started', {
        transformId: '',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: [],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('transformId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: '   ',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: [],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('transformId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: '',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: [],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('batchId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: -1,
        completeAtStep: 1,
        entityInstanceIds: [],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('startedAtStep must be a non-negative integer.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: -1,
        entityInstanceIds: [],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('completeAtStep must be a non-negative integer.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: null as any,
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('entityInstanceIds must be an array.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: ['ok', ''],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('entityInstanceIds must contain non-blank strings.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: ['ok', '   '],
      } as RuntimeEventPayload<'mission:started'>);
    }).toThrow('entityInstanceIds must contain non-blank strings.');

    expect(() => {
      bus.publish('mission:started', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        startedAtStep: 0,
        completeAtStep: 1,
        entityInstanceIds: ['entity:1'],
      } as RuntimeEventPayload<'mission:started'>);
    }).not.toThrow();
  });

  it('validates mission:completed payloads', () => {
    const bus = createBus();

    const validPayload: RuntimeEventPayload<'mission:completed'> = {
      transformId: 'transform:1',
      batchId: 'batch:1',
      completedAtStep: 1,
      outcomeKind: 'success',
      success: true,
      critical: false,
      outputs: [{ resourceId: 'res:gold', amount: 1 }],
      entityExperience: 5,
      entityInstanceIds: ['entity:1'],
    };

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        transformId: '',
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('transformId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        batchId: '',
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('batchId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        completedAtStep: -1,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('completedAtStep must be a non-negative integer.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'unknown' as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outcomeKind must be "success", "failure", or "critical".');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        success: 'yes' as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('success must be a boolean.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        critical: 'no' as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('critical must be a boolean.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'critical',
        success: false,
        critical: true,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outcomeKind "critical" requires success=true and critical=true.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'success',
        success: true,
        critical: true,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outcomeKind "success" requires success=true and critical=false.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'failure',
        success: true,
        critical: false,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outcomeKind "failure" requires success=false and critical=false.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outputs: null as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outputs must be an array.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outputs: [null] as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('outputs must contain objects.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outputs: [{ resourceId: '', amount: 1 }],
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('output.resourceId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outputs: [{ resourceId: 'res:gold', amount: Number.POSITIVE_INFINITY }],
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('output.amount must be a finite number.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        entityExperience: Number.NaN,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('entityExperience must be a finite number.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        entityInstanceIds: null as any,
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('entityInstanceIds must be an array.');

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        entityInstanceIds: ['ok', ''],
      } as RuntimeEventPayload<'mission:completed'>);
    }).toThrow('entityInstanceIds must contain non-blank strings.');

    expect(() => {
      bus.publish('mission:completed', validPayload);
    }).not.toThrow();

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'critical',
        success: true,
        critical: true,
      } as RuntimeEventPayload<'mission:completed'>);
    }).not.toThrow();

    expect(() => {
      bus.publish('mission:completed', {
        ...validPayload,
        outcomeKind: 'failure',
        success: false,
        critical: false,
      } as RuntimeEventPayload<'mission:completed'>);
    }).not.toThrow();
  });

  it('validates mission:stage-completed payloads', () => {
    const bus = createBus();

    const validPayload: RuntimeEventPayload<'mission:stage-completed'> = {
      transformId: 'transform:1',
      batchId: 'batch:1',
      stageId: 'stage-1',
      checkpoint: {
        outputs: [{ resourceId: 'res:gold', amount: 1 }],
      },
    };

    expect(() => {
      bus.publish('mission:stage-completed', {
        ...validPayload,
        stageId: '',
      } as RuntimeEventPayload<'mission:stage-completed'>);
    }).toThrow('stageId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:stage-completed', {
        ...validPayload,
        checkpoint: { outputs: null as any },
      } as RuntimeEventPayload<'mission:stage-completed'>);
    }).toThrow('outputs must be an array.');

    expect(() => {
      bus.publish('mission:stage-completed', {
        transformId: 'transform:1',
        batchId: 'batch:1',
        stageId: 'stage-1',
      } as RuntimeEventPayload<'mission:stage-completed'>);
    }).not.toThrow();

    expect(() => {
      bus.publish('mission:stage-completed', validPayload);
    }).not.toThrow();
  });

  it('validates mission:decision-required payloads', () => {
    const bus = createBus();

    const validPayload: RuntimeEventPayload<'mission:decision-required'> = {
      transformId: 'transform:1',
      batchId: 'batch:1',
      stageId: 'stage-1',
      prompt: 'Choose a path',
      options: [
        { id: 'left', label: 'Left', available: true },
        { id: 'right', label: 'Right', available: false },
      ],
      expiresAtStep: 5,
    };

    expect(() => {
      bus.publish('mission:decision-required', {
        ...validPayload,
        prompt: '',
      } as RuntimeEventPayload<'mission:decision-required'>);
    }).toThrow('prompt must be a non-blank string.');

    expect(() => {
      bus.publish('mission:decision-required', {
        ...validPayload,
        prompt: '   ',
      } as RuntimeEventPayload<'mission:decision-required'>);
    }).toThrow('prompt must be a non-blank string.');

    expect(() => {
      bus.publish('mission:decision-required', {
        ...validPayload,
        options: null as any,
      } as RuntimeEventPayload<'mission:decision-required'>);
    }).toThrow('options must be an array.');

    expect(() => {
      bus.publish('mission:decision-required', {
        ...validPayload,
        expiresAtStep: -1,
      } as RuntimeEventPayload<'mission:decision-required'>);
    }).toThrow('expiresAtStep must be a non-negative integer.');

    expect(() => {
      bus.publish('mission:decision-required', {
        ...validPayload,
        options: [{ id: 'left', label: '   ', available: true }],
      } as RuntimeEventPayload<'mission:decision-required'>);
    }).toThrow('option.label must be a non-blank string.');

    expect(() => {
      bus.publish('mission:decision-required', validPayload);
    }).not.toThrow();
  });

  it('validates mission:decision-made payloads', () => {
    const bus = createBus();

    const validPayload: RuntimeEventPayload<'mission:decision-made'> = {
      transformId: 'transform:1',
      batchId: 'batch:1',
      stageId: 'stage-1',
      optionId: 'left',
      nextStageId: 'next-stage',
    };

    expect(() => {
      bus.publish('mission:decision-made', {
        ...validPayload,
        optionId: '',
      } as RuntimeEventPayload<'mission:decision-made'>);
    }).toThrow('optionId must be a non-blank string.');

    expect(() => {
      bus.publish('mission:decision-made', {
        ...validPayload,
        nextStageId: '',
      } as RuntimeEventPayload<'mission:decision-made'>);
    }).toThrow('nextStageId must be a non-blank string or null.');

    expect(() => {
      bus.publish('mission:decision-made', {
        ...validPayload,
        nextStageId: '   ',
      } as RuntimeEventPayload<'mission:decision-made'>);
    }).toThrow('nextStageId must be a non-blank string or null.');

    expect(() => {
      bus.publish('mission:decision-made', {
        ...validPayload,
        nextStageId: null,
      } as RuntimeEventPayload<'mission:decision-made'>);
    }).not.toThrow();

    expect(() => {
      bus.publish('mission:decision-made', validPayload);
    }).not.toThrow();
  });
});
