import { evaluateCondition } from './condition-evaluator.js';
import { buildTransformSnapshot } from './transform-system.js';
const EMPTY_ARRAY = Object.freeze([]);
const FLAG_VISIBLE = 1 << 0;
const FLAG_UNLOCKED = 1 << 1;
const compareStableStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export function buildProgressionSnapshot(step, publishedAt, state) {
    const stepDurationMs = state?.stepDurationMs ?? 100;
    const resources = createResourceViews(stepDurationMs, state?.resources);
    const resourceAmounts = createResourceAmountLookup(resources);
    const generators = createGeneratorViews(step, state?.generators, state?.generatorPurchases, resourceAmounts);
    const upgrades = createUpgradeViews(state?.upgrades, state?.upgradePurchases, resourceAmounts);
    const automations = createAutomationViews(step, publishedAt, stepDurationMs, state?.automations);
    const transforms = createTransformViews(step, publishedAt, stepDurationMs, state?.transforms);
    const achievements = createAchievementViews(state?.achievements);
    const prestigeLayers = createPrestigeLayerViews(state?.prestigeLayers, state?.prestigeSystem);
    return Object.freeze({
        step,
        publishedAt,
        resources,
        generators,
        upgrades,
        automations,
        transforms,
        ...(achievements ? { achievements } : {}),
        prestigeLayers,
    });
}
function createResourceViews(stepDurationMs, source) {
    if (!source) {
        return EMPTY_ARRAY;
    }
    if (source.state) {
        const snapshot = source.state.snapshot({ mode: 'publish' });
        const views = [];
        for (let index = 0; index < snapshot.ids.length; index += 1) {
            const id = snapshot.ids[index];
            const displayName = source.metadata?.get(id)?.displayName ?? id;
            const capacityValue = source.state.getCapacity(index);
            const capacity = Number.isFinite(capacityValue) && capacityValue >= 0
                ? capacityValue
                : undefined;
            const perSecond = source.state.getNetPerSecond(index);
            const perTick = perSecond * (stepDurationMs / 1000);
            const view = Object.freeze({
                id,
                displayName,
                amount: snapshot.amounts[index] ?? 0,
                unlocked: source.state.isUnlocked(index),
                visible: source.state.isVisible(index),
                ...(capacity !== undefined ? { capacity } : {}),
                perSecond,
                perTick,
            });
            views.push(view);
        }
        const frozen = Object.freeze(views);
        source.state.resetPerTickAccumulators();
        return frozen;
    }
    if (source.serialized) {
        const { serialized } = source;
        const views = [];
        for (let index = 0; index < serialized.ids.length; index += 1) {
            const id = serialized.ids[index];
            const displayName = source.metadata?.get(id)?.displayName ?? id;
            const capacityValue = serialized.capacities[index] ?? undefined;
            const capacity = capacityValue == null ? undefined : capacityValue;
            const unlocked = serialized.unlocked?.[index] ??
                ((serialized.flags[index] ?? 0) & FLAG_UNLOCKED) !== 0;
            const visible = serialized.visible?.[index] ??
                ((serialized.flags[index] ?? 0) & FLAG_VISIBLE) !== 0;
            const view = Object.freeze({
                id,
                displayName,
                amount: serialized.amounts[index] ?? 0,
                unlocked: Boolean(unlocked),
                visible: Boolean(visible),
                ...(capacity !== undefined ? { capacity } : {}),
                perSecond: 0,
                perTick: 0,
            });
            views.push(view);
        }
        return Object.freeze(views);
    }
    return EMPTY_ARRAY;
}
function createGeneratorViews(step, generators, evaluator, resourceAmounts) {
    if (!generators || generators.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const generator of generators) {
        const quote = evaluateGeneratorCosts(evaluator, generator.id, resourceAmounts);
        const produces = normalizeRates(generator.produces);
        const consumes = normalizeRates(generator.consumes);
        const nextPurchaseReadyAtStep = generator.nextPurchaseReadyAtStep ?? step + 1;
        const unlockHint = typeof generator.unlockHint === 'string' && generator.unlockHint.trim().length > 0
            ? generator.unlockHint
            : undefined;
        const canAfford = areCostsAffordable(resourceAmounts, quote);
        const view = Object.freeze({
            id: generator.id,
            displayName: generator.displayName ?? generator.id,
            owned: Number.isFinite(generator.owned) ? generator.owned : 0,
            enabled: generator.enabled ?? true,
            unlocked: Boolean(generator.isUnlocked),
            visible: Boolean(generator.isVisible),
            ...(unlockHint ? { unlockHint } : {}),
            costs: quote,
            canAfford,
            produces,
            consumes,
            nextPurchaseReadyAtStep,
        });
        views.push(view);
    }
    return Object.freeze(views);
}
function createUpgradeViews(upgrades, evaluator, resourceAmounts) {
    if (!upgrades || upgrades.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const upgrade of upgrades) {
        const quote = evaluateUpgradeQuote(evaluator, upgrade.id);
        const costs = quote?.costs ??
            upgrade.costs ??
            EMPTY_ARRAY;
        const normalizedCosts = normalizeUpgradeCosts(costs, resourceAmounts);
        const status = quote?.status ?? upgrade.status ?? 'locked';
        const unlockHint = typeof upgrade.unlockHint === 'string' && upgrade.unlockHint.trim().length > 0
            ? upgrade.unlockHint
            : undefined;
        const canAfford = areCostsAffordable(resourceAmounts, normalizedCosts);
        const view = Object.freeze({
            id: upgrade.id,
            displayName: upgrade.displayName ?? upgrade.id,
            status,
            canAfford,
            costs: normalizedCosts.length > 0 ? normalizedCosts : undefined,
            ...(unlockHint ? { unlockHint } : {}),
            visible: Boolean(upgrade.isVisible),
        });
        views.push(view);
    }
    return Object.freeze(views);
}
function createAchievementViews(achievements) {
    if (!achievements || achievements.length === 0) {
        return undefined;
    }
    const views = [];
    for (const achievement of achievements) {
        const progress = Number(achievement.progress);
        const target = Number(achievement.target);
        const completions = Number(achievement.completions);
        const nextRepeatableAtStep = Number(achievement.nextRepeatableAtStep);
        const lastCompletedStep = Number(achievement.lastCompletedStep);
        const view = Object.freeze({
            id: achievement.id,
            displayName: achievement.displayName ?? achievement.id,
            description: achievement.description ?? '',
            category: achievement.category,
            tier: achievement.tier,
            mode: achievement.mode,
            visible: Boolean(achievement.isVisible),
            unlocked: Number.isFinite(completions) && completions > 0,
            completions: Number.isFinite(completions) && completions > 0
                ? Math.floor(completions)
                : 0,
            progress: Number.isFinite(progress) ? progress : 0,
            target: Number.isFinite(target) ? target : 0,
            ...(Number.isFinite(nextRepeatableAtStep) && nextRepeatableAtStep >= 0
                ? { nextRepeatableAtStep: Math.floor(nextRepeatableAtStep) }
                : {}),
            ...(Number.isFinite(lastCompletedStep) && lastCompletedStep >= 0
                ? { lastCompletedStep: Math.floor(lastCompletedStep) }
                : {}),
        });
        views.push(view);
    }
    return views.length > 0 ? Object.freeze(views) : undefined;
}
function createAutomationViews(step, publishedAt, stepDurationMs, source) {
    if (!source || source.definitions.length === 0) {
        return EMPTY_ARRAY;
    }
    const safeStepDurationMs = Number.isFinite(stepDurationMs) && stepDurationMs >= 0 ? stepDurationMs : 0;
    const sorted = [...source.definitions].sort((left, right) => {
        const orderA = left.order ?? 0;
        const orderB = right.order ?? 0;
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return compareStableStrings(left.id, right.id);
    });
    const views = [];
    const conditionContext = source.conditionContext;
    for (const automation of sorted) {
        const state = source.state.get(automation.id);
        const unlocked = state?.unlocked ?? false;
        const visible = automation.visibilityCondition && conditionContext
            ? evaluateCondition(automation.visibilityCondition, conditionContext)
            : unlocked;
        const rawCooldownExpiresStep = state?.cooldownExpiresStep;
        const cooldownExpiresStep = Number.isFinite(rawCooldownExpiresStep)
            ? Number(rawCooldownExpiresStep)
            : 0;
        const cooldownRemainingMs = Math.max(0, (cooldownExpiresStep - step) * safeStepDurationMs);
        const rawLastFiredStep = state?.lastFiredStep;
        const lastFiredStep = Number.isFinite(rawLastFiredStep)
            ? Number(rawLastFiredStep)
            : null;
        const lastTriggeredAt = lastFiredStep !== null && lastFiredStep >= 0
            ? publishedAt - (step - lastFiredStep) * safeStepDurationMs
            : null;
        views.push(Object.freeze({
            id: automation.id,
            displayName: automation.name.default,
            description: automation.description.default,
            unlocked,
            visible,
            isEnabled: state?.enabled ?? automation.enabledByDefault ?? false,
            lastTriggeredAt,
            cooldownRemainingMs,
            isOnCooldown: cooldownRemainingMs > 0,
        }));
    }
    return Object.freeze(views);
}
function createTransformViews(step, publishedAt, stepDurationMs, source) {
    if (!source || source.definitions.length === 0) {
        return EMPTY_ARRAY;
    }
    const snapshot = buildTransformSnapshot(step, publishedAt, {
        transforms: source.definitions,
        state: source.state,
        stepDurationMs,
        resourceState: source.resourceState,
        conditionContext: source.conditionContext,
    });
    return snapshot.transforms;
}
function createResourceAmountLookup(resources) {
    if (!resources || resources.length === 0) {
        return new Map();
    }
    const lookup = new Map();
    for (const resource of resources) {
        lookup.set(resource.id, Number.isFinite(resource.amount) ? resource.amount : 0);
    }
    return lookup;
}
function normalizeRates(rates) {
    if (!rates || rates.length === 0) {
        return EMPTY_ARRAY;
    }
    return Object.freeze(rates.map((rate) => Object.freeze({
        resourceId: rate.resourceId,
        rate: Number.isFinite(rate.rate) ? rate.rate : 0,
    })));
}
function evaluateGeneratorCosts(evaluator, generatorId, resourceAmounts) {
    if (!evaluator) {
        return EMPTY_ARRAY;
    }
    let quote;
    try {
        quote = evaluator.getPurchaseQuote(generatorId, 1);
    }
    catch {
        return EMPTY_ARRAY;
    }
    if (!quote || !Array.isArray(quote.costs)) {
        return EMPTY_ARRAY;
    }
    return normalizeGeneratorCosts(quote.costs, resourceAmounts);
}
function normalizeGeneratorCosts(costs, resourceAmounts) {
    if (!costs || costs.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const cost of costs) {
        if (typeof cost.resourceId !== 'string') {
            continue;
        }
        const amount = Number(cost.amount);
        if (!Number.isFinite(amount) || amount < 0) {
            continue;
        }
        const currentAmount = resolveCurrentAmount(resourceAmounts, cost.resourceId);
        const canAfford = isCostAffordable(resourceAmounts, cost.resourceId, amount);
        views.push(Object.freeze({
            resourceId: cost.resourceId,
            amount,
            canAfford,
            ...(currentAmount !== undefined ? { currentAmount } : {}),
        }));
    }
    return views.length > 0
        ? Object.freeze(views)
        : EMPTY_ARRAY;
}
function evaluateUpgradeQuote(evaluator, upgradeId) {
    if (!evaluator) {
        return undefined;
    }
    try {
        return evaluator.getPurchaseQuote(upgradeId);
    }
    catch {
        return undefined;
    }
}
function normalizeUpgradeCosts(costs, resourceAmounts) {
    if (!costs || costs.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const cost of costs) {
        if (typeof cost?.resourceId !== 'string') {
            continue;
        }
        const amount = Number(cost.amount);
        if (!Number.isFinite(amount) || amount < 0) {
            continue;
        }
        const currentAmount = resolveCurrentAmount(resourceAmounts, cost.resourceId);
        const canAfford = isCostAffordable(resourceAmounts, cost.resourceId, amount);
        views.push(Object.freeze({
            resourceId: cost.resourceId,
            amount,
            canAfford,
            ...(currentAmount !== undefined ? { currentAmount } : {}),
        }));
    }
    return views.length > 0
        ? Object.freeze(views)
        : EMPTY_ARRAY;
}
function isCostAffordable(amountsByResourceId, resourceId, amount) {
    const available = amountsByResourceId.get(resourceId);
    if (available === undefined || !Number.isFinite(available)) {
        return false;
    }
    if (!Number.isFinite(amount) || amount < 0) {
        return false;
    }
    return available >= amount;
}
function resolveCurrentAmount(amountsByResourceId, resourceId) {
    const currentAmount = amountsByResourceId.get(resourceId);
    return Number.isFinite(currentAmount) ? currentAmount : undefined;
}
function areCostsAffordable(amountsByResourceId, costs) {
    if (!costs || costs.length === 0) {
        return true;
    }
    for (const cost of costs) {
        if (!isCostAffordable(amountsByResourceId, cost.resourceId, cost.amount)) {
            return false;
        }
    }
    return true;
}
function createPrestigeLayerViews(prestigeLayers, evaluator) {
    if (!prestigeLayers || prestigeLayers.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const layer of prestigeLayers) {
        const quote = evaluatePrestigeQuote(evaluator, layer.id);
        const unlockHint = typeof layer.unlockHint === 'string' && layer.unlockHint.trim().length > 0
            ? layer.unlockHint
            : undefined;
        const view = Object.freeze({
            id: layer.id,
            displayName: layer.displayName ?? layer.id,
            summary: layer.summary,
            status: quote?.status ?? 'locked',
            ...(unlockHint ? { unlockHint } : {}),
            visible: Boolean(layer.isVisible),
            rewardPreview: quote?.reward,
            resetTargets: quote?.resetTargets ?? EMPTY_ARRAY,
            resetGenerators: quote?.resetGenerators,
            resetUpgrades: quote?.resetUpgrades,
            retainedTargets: quote?.retainedTargets ?? EMPTY_ARRAY,
        });
        views.push(view);
    }
    return Object.freeze(views);
}
function evaluatePrestigeQuote(evaluator, layerId) {
    if (!evaluator) {
        return undefined;
    }
    try {
        return evaluator.getPrestigeQuote(layerId);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=progression.js.map