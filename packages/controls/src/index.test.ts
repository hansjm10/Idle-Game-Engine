import { describe, expect, it } from 'vitest';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';

import type {
  ControlAction,
  ControlContext,
  ControlEvent,
  ControlScheme,
} from './index.js';
import {
  createControlCommand,
  createControlCommands,
  resolveControlActions,
} from './index.js';

const toggleAction: ControlAction<typeof RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR> =
  {
    id: 'action:toggle',
    commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
    payload: { generatorId: 'gen:alpha', enabled: true },
  };

const collectStartAction: ControlAction<
  typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE
> = {
  id: 'action:collect-start',
  commandType: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
  payload: { resourceId: 'res:alpha', amount: 1 },
};

const collectRepeatAction: ControlAction<
  typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE
> = {
  id: 'action:collect-repeat',
  commandType: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
  payload: { resourceId: 'res:alpha', amount: 2 },
};

const collectAllAction: ControlAction<
  typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE
> = {
  id: 'action:collect-all',
  commandType: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
  payload: { resourceId: 'res:alpha', amount: 3 },
};

const scheme: ControlScheme = {
  id: 'scheme:default',
  version: '1',
  actions: [
    toggleAction,
    collectStartAction,
    collectRepeatAction,
    collectAllAction,
  ],
  bindings: [
    {
      id: 'binding:toggle-start',
      intent: 'toggle',
      actionId: toggleAction.id,
      phases: ['start'],
    },
    {
      id: 'binding:collect-start',
      intent: 'collect',
      actionId: collectStartAction.id,
      phases: ['start'],
    },
    {
      id: 'binding:collect-repeat',
      intent: 'collect',
      actionId: collectRepeatAction.id,
      phases: ['repeat'],
    },
    {
      id: 'binding:collect-all',
      intent: 'collect',
      actionId: collectAllAction.id,
    },
    {
      id: 'binding:collect-missing',
      intent: 'collect',
      actionId: 'action:missing',
      phases: ['start'],
    },
    {
      id: 'binding:collect-empty',
      intent: 'collect',
      actionId: collectAllAction.id,
      phases: [],
    },
  ],
};

describe('resolveControlActions', () => {
  it('matches intent and phases, treating missing phases as unfiltered', () => {
    const event: ControlEvent = { intent: 'collect', phase: 'start' };

    expect(resolveControlActions(scheme, event)).toEqual([
      collectStartAction,
      collectAllAction,
    ]);
  });

  it('matches repeat phases and preserves binding order', () => {
    const event: ControlEvent = { intent: 'collect', phase: 'repeat' };

    expect(resolveControlActions(scheme, event)).toEqual([
      collectRepeatAction,
      collectAllAction,
    ]);
  });

  it('returns empty when nothing matches', () => {
    const event: ControlEvent = { intent: 'missing', phase: 'start' };

    expect(resolveControlActions(scheme, event)).toEqual([]);
  });

  it('ignores bindings with empty phases', () => {
    const schemeWithEmptyPhases: ControlScheme = {
      id: 'scheme:empty-phases',
      version: '1',
      actions: [toggleAction],
      bindings: [
        {
          id: 'binding:empty-phases',
          intent: 'toggle',
          actionId: toggleAction.id,
          phases: [],
        },
      ],
    };

    const event: ControlEvent = { intent: 'toggle', phase: 'start' };

    expect(resolveControlActions(schemeWithEmptyPhases, event)).toEqual([]);
  });

  it('throws when action ids are duplicated', () => {
    const schemeWithDuplicates: ControlScheme = {
      id: 'scheme:duplicate-actions',
      version: '1',
      actions: [
        toggleAction,
        {
          ...toggleAction,
          payload: { generatorId: 'gen:beta', enabled: false },
        },
      ],
      bindings: [
        {
          id: 'binding:toggle-start',
          intent: 'toggle',
          actionId: toggleAction.id,
          phases: ['start'],
        },
      ],
    };

    const event: ControlEvent = { intent: 'toggle', phase: 'start' };

    expect(() => resolveControlActions(schemeWithDuplicates, event)).toThrowError(
      'Control action with id "action:toggle" is duplicated.',
    );
  });
});

describe('createControlCommand', () => {
  it('stamps priority, step, timestamp, and requestId deterministically', () => {
    const context: ControlContext = {
      step: 12,
      timestamp: 1200,
      priority: CommandPriority.SYSTEM,
      requestId: 'request:alpha',
    };

    const command = createControlCommand(
      {
        ...toggleAction,
        priority: CommandPriority.AUTOMATION,
      },
      context,
    );

    expect(command).toEqual({
      type: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
      payload: { generatorId: 'gen:alpha', enabled: true },
      priority: CommandPriority.AUTOMATION,
      timestamp: 1200,
      step: 12,
      requestId: 'request:alpha',
    });
  });

  it('defaults to PLAYER priority when none is provided', () => {
    const context: ControlContext = { step: 3, timestamp: 300 };

    const command = createControlCommand(toggleAction, context);

    expect(command.priority).toBe(CommandPriority.PLAYER);
  });
});

describe('createControlCommands', () => {
  it('creates commands for all matching bindings', () => {
    const context: ControlContext = { step: 4, timestamp: 400 };
    const event: ControlEvent = { intent: 'collect', phase: 'repeat' };

    expect(createControlCommands(scheme, event, context)).toEqual([
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        payload: { resourceId: 'res:alpha', amount: 2 },
        priority: CommandPriority.PLAYER,
        timestamp: 400,
        step: 4,
        requestId: undefined,
      },
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        payload: { resourceId: 'res:alpha', amount: 3 },
        priority: CommandPriority.PLAYER,
        timestamp: 400,
        step: 4,
        requestId: undefined,
      },
    ]);
  });
});
