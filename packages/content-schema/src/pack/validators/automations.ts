import { assertAllowlisted } from './allowlists.js';
import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import type { CrossReferenceState } from './state.js';
import type { ParsedContentPack } from '../schema.js';

type AutomationTrigger = ParsedContentPack['automations'][number]['trigger'];
type AutomationTriggerByKind<K extends AutomationTrigger['kind']> = Extract<
  AutomationTrigger,
  { kind: K }
>;

type EnsureContentReference = CrossReferenceState['ensureContentReference'];

const ensureOptionalContentReference = (
  ensureContentReference: EnsureContentReference,
  map: Parameters<EnsureContentReference>[0],
  id: string | undefined,
  path: readonly (string | number)[],
  message: string,
) => {
  if (!id) {
    return;
  }
  ensureContentReference(map, id, path, message);
};

const ensureOptionalFormulaReferencesAtPath = (
  formula: Parameters<typeof ensureFormulaReferencesAtPath>[0] | undefined,
  path: readonly (string | number)[],
  ctx: CrossReferenceState['ctx'],
  maps: CrossReferenceState['formulaMaps'],
) => {
  if (!formula) {
    return;
  }
  ensureFormulaReferencesAtPath(formula, path, ctx, maps);
};

const assertAllowlistedIfProvided = (
  spec: CrossReferenceState['context']['allowlists']['systemAutomationTargets'],
  id: string | undefined,
  path: readonly (string | number)[],
  ctx: CrossReferenceState['ctx'],
  warningSink: CrossReferenceState['context']['warningSink'],
  warningCode: string,
  message: string,
) => {
  if (!id) {
    return;
  }
  assertAllowlisted(spec, id, path, ctx, warningSink, warningCode, message);
};

const validateAutomationTarget = (
  state: CrossReferenceState,
  automation: ParsedContentPack['automations'][number],
  index: number,
) => {
  const { ctx, context, indexes, formulaMaps, ensureContentReference } = state;
  const { resources: resourceIndex, generators: generatorIndex, upgrades: upgradeIndex } =
    indexes;
  const warn = context.warningSink;

  switch (automation.targetType) {
    case 'generator':
      ensureOptionalContentReference(
        ensureContentReference,
        generatorIndex,
        automation.targetId,
        ['automations', index, 'targetId'],
        `Automation "${automation.id}" references unknown generator "${automation.targetId}".`,
      );
      return;
    case 'purchaseGenerator':
      ensureOptionalContentReference(
        ensureContentReference,
        generatorIndex,
        automation.targetId,
        ['automations', index, 'targetId'],
        `Automation "${automation.id}" references unknown generator "${automation.targetId}".`,
      );
      ensureOptionalFormulaReferencesAtPath(
        automation.targetCount,
        ['automations', index, 'targetCount'],
        ctx,
        formulaMaps,
      );
      return;
    case 'upgrade':
      ensureOptionalContentReference(
        ensureContentReference,
        upgradeIndex,
        automation.targetId,
        ['automations', index, 'targetId'],
        `Automation "${automation.id}" references unknown upgrade "${automation.targetId}".`,
      );
      return;
    case 'collectResource':
      ensureOptionalContentReference(
        ensureContentReference,
        resourceIndex,
        automation.targetId,
        ['automations', index, 'targetId'],
        `Automation "${automation.id}" references unknown resource "${automation.targetId}".`,
      );
      ensureOptionalFormulaReferencesAtPath(
        automation.targetAmount,
        ['automations', index, 'targetAmount'],
        ctx,
        formulaMaps,
      );
      return;
    case 'system':
      assertAllowlistedIfProvided(
        context.allowlists.systemAutomationTargets,
        automation.systemTargetId,
        ['automations', index, 'systemTargetId'],
        ctx,
        warn,
        'allowlist.systemAutomationTarget.missing',
        `Automation "${automation.id}" references system target "${automation.systemTargetId}" not present in the allowlist.`,
      );
      return;
    default:
      return;
  }
};

const validateAutomationCosts = (
  state: CrossReferenceState,
  automation: ParsedContentPack['automations'][number],
  index: number,
) => {
  const { ctx, indexes, formulaMaps, ensureContentReference } = state;
  const { resources: resourceIndex } = indexes;

  if (automation.resourceCost) {
    ensureContentReference(
      resourceIndex,
      automation.resourceCost.resourceId,
      ['automations', index, 'resourceCost', 'resourceId'],
      `Automation "${automation.id}" references unknown resource "${automation.resourceCost.resourceId}".`,
    );
    ensureFormulaReferencesAtPath(
      automation.resourceCost.rate,
      ['automations', index, 'resourceCost', 'rate'],
      ctx,
      formulaMaps,
    );
  }
  if (automation.cooldown) {
    ensureFormulaReferencesAtPath(
      automation.cooldown,
      ['automations', index, 'cooldown'],
      ctx,
      formulaMaps,
    );
  }
};

const validateAutomationTrigger = (
  state: CrossReferenceState,
  automation: ParsedContentPack['automations'][number],
  index: number,
) => {
  const {
    ctx,
    indexes,
    formulaMaps,
    ensureContentReference,
    ensureRuntimeEventKnown,
    runtimeEventSeverity,
  } = state;
  const { resources: resourceIndex } = indexes;

  const automationTriggerHandlers = {
    resourceThreshold: (
      trigger: AutomationTriggerByKind<'resourceThreshold'>,
      triggerPath: readonly (string | number)[],
      automationId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        trigger.resourceId,
        [...triggerPath, 'resourceId'],
        `Automation "${automationId}" trigger references unknown resource "${trigger.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(
        trigger.threshold,
        [...triggerPath, 'threshold'],
        ctx,
        formulaMaps,
      );
    },
    event: (trigger: AutomationTriggerByKind<'event'>, triggerPath: readonly (string | number)[]) => {
      ensureRuntimeEventKnown(
        trigger.eventId,
        [...triggerPath, 'eventId'],
        runtimeEventSeverity,
      );
    },
    interval: () => undefined,
    commandQueueEmpty: () => undefined,
  } satisfies {
    [K in AutomationTrigger['kind']]: (
      trigger: AutomationTriggerByKind<K>,
      triggerPath: readonly (string | number)[],
      automationId: string,
    ) => void;
  };

  const handleAutomationTrigger = (
    trigger: AutomationTrigger,
    triggerPath: readonly (string | number)[],
    automationId: string,
  ) => {
    const handler = automationTriggerHandlers[trigger.kind] as (
      entry: AutomationTrigger,
      currentPath: readonly (string | number)[],
      currentAutomationId: string,
    ) => void;
    handler(trigger, triggerPath, automationId);
  };

  handleAutomationTrigger(automation.trigger, ['automations', index, 'trigger'], automation.id);
};

const validateAutomationConditions = (
  state: CrossReferenceState,
  automation: ParsedContentPack['automations'][number],
  index: number,
) => {
  const { ctx, context } = state;
  const warn = context.warningSink;

  if (automation.scriptId) {
    assertAllowlisted(
      context.allowlists.scripts,
      automation.scriptId,
      ['automations', index, 'scriptId'],
      ctx,
      warn,
      'allowlist.script.missing',
      `Automation "${automation.id}" references script "${automation.scriptId}" that is not in the scripts allowlist.`,
    );
  }
  validateConditionNode(state, automation.unlockCondition, ['automations', index, 'unlockCondition']);
  if (automation.visibilityCondition) {
    validateConditionNode(state, automation.visibilityCondition, [
      'automations',
      index,
      'visibilityCondition',
    ]);
  }
};

export const validateAutomations = (state: CrossReferenceState) => {
  const { pack } = state;

  pack.automations.forEach((automation, index) => {
    validateAutomationTarget(state, automation, index);
    validateAutomationCosts(state, automation, index);
    validateAutomationTrigger(state, automation, index);
    validateAutomationConditions(state, automation, index);
  });
};
