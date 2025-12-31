import { describe, expect, it } from 'vitest';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';

import type {
  ControlAction,
  ControlContext,
  ControlEvent,
  ControlScheme,
} from './index.js';
import {
  canonicalizeControlScheme,
  CONTROL_SCHEME_VALIDATION_CODES,
  createControlCommand,
  createControlCommands,
  normalizeControlScheme,
  resolveControlActions,
  validateControlScheme,
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

  it('defaults to context priority when action priority is missing', () => {
    const context: ControlContext = {
      step: 8,
      timestamp: 800,
      priority: CommandPriority.AUTOMATION,
    };

    const command = createControlCommand(toggleAction, context);

    expect(command.priority).toBe(CommandPriority.AUTOMATION);
  });

  it('defaults to PLAYER priority when none is provided', () => {
    const context: ControlContext = { step: 3, timestamp: 300 };

    const command = createControlCommand(toggleAction, context);

    expect(command.priority).toBe(CommandPriority.PLAYER);
  });
});

describe('createControlCommands', () => {
  it('creates commands for all matching bindings in binding order', () => {
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

describe('normalizeControlScheme', () => {
  it('preserves ordering while normalizing phases', () => {
    const localScheme: ControlScheme = {
      id: 'scheme:normalize',
      version: '1',
      actions: [
        {
          id: 'action:zeta',
          commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          payload: { generatorId: 'gen:zeta', enabled: true },
        },
        {
          id: 'action:alpha',
          commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          payload: { generatorId: 'gen:alpha', enabled: false },
        },
      ],
      bindings: [
        {
          id: 'binding:zeta',
          intent: 'toggle',
          actionId: 'action:zeta',
          phases: ['repeat', 'start', 'repeat'],
        },
        {
          id: 'binding:alpha',
          intent: 'toggle',
          actionId: 'action:alpha',
          phases: ['end', 'start'],
        },
      ],
    };

    const normalized = normalizeControlScheme(localScheme);

    expect(normalized.actions.map((action) => action.id)).toEqual([
      'action:zeta',
      'action:alpha',
    ]);
    expect(normalized.bindings.map((binding) => binding.id)).toEqual([
      'binding:zeta',
      'binding:alpha',
    ]);
    expect(normalized.bindings[0]?.phases).toEqual(['repeat', 'start']);
    expect(normalized.bindings[1]?.phases).toEqual(['end', 'start']);
  });

  it('preserves missing or empty phases', () => {
    const localScheme: ControlScheme = {
      id: 'scheme:normalize-phases',
      version: '1',
      actions: [toggleAction],
      bindings: [
        {
          id: 'binding:missing',
          intent: 'toggle',
          actionId: toggleAction.id,
        },
        {
          id: 'binding:empty',
          intent: 'toggle',
          actionId: toggleAction.id,
          phases: [],
        },
      ],
    };

    const normalized = normalizeControlScheme(localScheme);
    const emptyBinding = normalized.bindings.find(
      (binding) => binding.id === 'binding:empty',
    );
    const missingBinding = normalized.bindings.find(
      (binding) => binding.id === 'binding:missing',
    );

    expect(emptyBinding?.phases).toEqual([]);
    expect(missingBinding?.phases).toBeUndefined();
  });
});

describe('canonicalizeControlScheme', () => {
  it('sorts actions/bindings by id and normalizes phases', () => {
    const localScheme: ControlScheme = {
      id: 'scheme:canonicalize',
      version: '1',
      actions: [
        {
          id: 'action:zeta',
          commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          payload: { generatorId: 'gen:zeta', enabled: true },
        },
        {
          id: 'action:alpha',
          commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          payload: { generatorId: 'gen:alpha', enabled: false },
        },
      ],
      bindings: [
        {
          id: 'binding:zeta',
          intent: 'toggle',
          actionId: 'action:zeta',
          phases: ['repeat', 'start', 'repeat'],
        },
        {
          id: 'binding:alpha',
          intent: 'toggle',
          actionId: 'action:alpha',
          phases: ['end', 'start'],
        },
      ],
    };

    const canonical = canonicalizeControlScheme(localScheme);

    expect(canonical.actions.map((action) => action.id)).toEqual([
      'action:alpha',
      'action:zeta',
    ]);
    expect(canonical.bindings.map((binding) => binding.id)).toEqual([
      'binding:alpha',
      'binding:zeta',
    ]);
    expect(canonical.bindings[0]?.phases).toEqual(['end', 'start']);
    expect(canonical.bindings[1]?.phases).toEqual(['repeat', 'start']);
  });
});

describe('validateControlScheme', () => {
  it('reports duplicate ids and missing action references', () => {
    const baseAction: ControlAction<
      typeof RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR
    > = {
      id: 'action:duplicate',
      commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
      payload: { generatorId: 'gen:alpha', enabled: true },
    };

    const localScheme: ControlScheme = {
      id: 'scheme:validation',
      version: '1',
      actions: [
        baseAction,
        {
          ...baseAction,
          payload: { generatorId: 'gen:beta', enabled: false },
        },
      ],
      bindings: [
        {
          id: 'binding:duplicate',
          intent: 'toggle',
          actionId: baseAction.id,
        },
        {
          id: 'binding:duplicate',
          intent: 'toggle',
          actionId: baseAction.id,
        },
        {
          id: 'binding:missing-action',
          intent: 'toggle',
          actionId: 'action:missing',
        },
      ],
    };

    expect(validateControlScheme(localScheme)).toEqual([
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_ACTION_ID,
        message:
          'Duplicate control action id "action:duplicate" also defined at index 0.',
        path: ['actions', 1, 'id'],
        severity: 'error',
      },
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_BINDING_ID,
        message:
          'Duplicate control binding id "binding:duplicate" also defined at index 0.',
        path: ['bindings', 1, 'id'],
        severity: 'error',
      },
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.MISSING_ACTION_REFERENCE,
        message:
          'Control binding "binding:missing-action" references missing action id "action:missing".',
        path: ['bindings', 2, 'actionId'],
        severity: 'error',
      },
    ]);
  });

  it('reports issues for each extra duplicate occurrence', () => {
    const baseAction: ControlAction<
      typeof RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR
    > = {
      id: 'action:duplicate-many',
      commandType: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
      payload: { generatorId: 'gen:alpha', enabled: true },
    };

    const localScheme: ControlScheme = {
      id: 'scheme:duplicate-many',
      version: '1',
      actions: [
        baseAction,
        {
          ...baseAction,
          payload: { generatorId: 'gen:beta', enabled: false },
        },
        {
          ...baseAction,
          payload: { generatorId: 'gen:gamma', enabled: true },
        },
      ],
      bindings: [
        {
          id: 'binding:duplicate-many',
          intent: 'toggle',
          actionId: baseAction.id,
        },
        {
          id: 'binding:duplicate-many',
          intent: 'toggle',
          actionId: baseAction.id,
        },
        {
          id: 'binding:duplicate-many',
          intent: 'toggle',
          actionId: baseAction.id,
        },
      ],
    };

    expect(validateControlScheme(localScheme)).toEqual([
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_ACTION_ID,
        message:
          'Duplicate control action id "action:duplicate-many" also defined at index 0.',
        path: ['actions', 1, 'id'],
        severity: 'error',
      },
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_ACTION_ID,
        message:
          'Duplicate control action id "action:duplicate-many" also defined at index 0.',
        path: ['actions', 2, 'id'],
        severity: 'error',
      },
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_BINDING_ID,
        message:
          'Duplicate control binding id "binding:duplicate-many" also defined at index 0.',
        path: ['bindings', 1, 'id'],
        severity: 'error',
      },
      {
        code: CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_BINDING_ID,
        message:
          'Duplicate control binding id "binding:duplicate-many" also defined at index 0.',
        path: ['bindings', 2, 'id'],
        severity: 'error',
      },
    ]);
  });

  it('returns no issues for valid schemes', () => {
    const localScheme: ControlScheme = {
      id: 'scheme:valid',
      version: '1',
      actions: [toggleAction, collectStartAction],
      bindings: [
        {
          id: 'binding:toggle',
          intent: 'toggle',
          actionId: toggleAction.id,
        },
        {
          id: 'binding:collect',
          intent: 'collect',
          actionId: collectStartAction.id,
        },
      ],
    };

    expect(validateControlScheme(localScheme)).toEqual([]);
  });
});
