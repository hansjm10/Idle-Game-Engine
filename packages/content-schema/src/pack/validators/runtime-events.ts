import { z } from 'zod';

import { assertAllowlisted } from './allowlists.js';
import type { CrossReferenceState } from './state.js';
import { toMutablePath } from '../utils.js';
import type { ParsedContentPack } from '../schema.js';

type RuntimeEventEmitter = ParsedContentPack['runtimeEvents'][number]['emits'][number];
type RuntimeEventEmitterBySource<K extends RuntimeEventEmitter['source']> =
  RuntimeEventEmitter & { source: K };

export const validateRuntimeEvents = (state: CrossReferenceState) => {
  const { pack, ctx, context, warn, indexes } = state;

  const runtimeEventEmitterHandlers = {
    achievement: (
      emitter: RuntimeEventEmitterBySource<'achievement'>,
      path: readonly (string | number)[],
    ) => {
      if (!indexes.achievements.has(emitter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Runtime event emitter references unknown achievement "${emitter.id}".`,
        });
      }
    },
    upgrade: (
      emitter: RuntimeEventEmitterBySource<'upgrade'>,
      path: readonly (string | number)[],
    ) => {
      if (!indexes.upgrades.has(emitter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Runtime event emitter references unknown upgrade "${emitter.id}".`,
        });
      }
    },
    transform: (
      emitter: RuntimeEventEmitterBySource<'transform'>,
      path: readonly (string | number)[],
    ) => {
      if (!indexes.transforms.has(emitter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Runtime event emitter references unknown transform "${emitter.id}".`,
        });
      }
    },
    script: (
      emitter: RuntimeEventEmitterBySource<'script'>,
      path: readonly (string | number)[],
    ) => {
      assertAllowlisted(
        context.allowlists.scripts,
        emitter.id,
        path,
        ctx,
        warn,
        'allowlist.script.missing',
        `Script "${emitter.id}" is not declared in the scripts allowlist.`,
      );
    },
  } satisfies {
    [K in RuntimeEventEmitter['source']]: (
      emitter: RuntimeEventEmitterBySource<K>,
      path: readonly (string | number)[],
    ) => void;
  };

  const handleRuntimeEventEmitter = (
    emitter: RuntimeEventEmitter,
    path: readonly (string | number)[],
  ) => {
    const handler = runtimeEventEmitterHandlers[emitter.source] as (
      entry: RuntimeEventEmitter,
      currentPath: readonly (string | number)[],
    ) => void;
    handler(emitter, path);
  };

  pack.runtimeEvents.forEach((event, index) => {
    if (context.runtimeEventCatalogue.has(event.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['runtimeEvents', index, 'id'] as const),
        message: `Runtime event "${event.id}" collides with an existing catalogue entry.`,
      });
    }

    event.emits.forEach((emitter, emitterIndex) => {
      handleRuntimeEventEmitter(emitter, [
        'runtimeEvents',
        index,
        'emits',
        emitterIndex,
        'id',
      ]);
    });
  });
};

