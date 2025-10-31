const EMPTY_ARRAY = Object.freeze([]);
const FLAG_VISIBLE = 1 << 0;
const FLAG_UNLOCKED = 1 << 1;
export function buildProgressionSnapshot(step, publishedAt, state) {
    const stepDurationMs = state?.stepDurationMs ?? 100;
    const resources = createResourceViews(stepDurationMs, state?.resources);
    const generators = createGeneratorViews(step, state?.generators, state?.generatorPurchases);
    const upgrades = createUpgradeViews(state?.upgrades, state?.upgradePurchases);
    return Object.freeze({
        step,
        publishedAt,
        resources,
        generators,
        upgrades,
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
                isUnlocked: source.state.isUnlocked(index),
                isVisible: source.state.isVisible(index),
                ...(capacity !== undefined ? { capacity } : {}),
                perTick,
            });
            views.push(view);
        }
        return Object.freeze(views);
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
                isUnlocked: Boolean(unlocked),
                isVisible: Boolean(visible),
                ...(capacity !== undefined ? { capacity } : {}),
                perTick: 0,
            });
            views.push(view);
        }
        return Object.freeze(views);
    }
    return EMPTY_ARRAY;
}
function createGeneratorViews(step, generators, evaluator) {
    if (!generators || generators.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const generator of generators) {
        const quote = evaluateGeneratorCosts(evaluator, generator.id);
        const produces = normalizeRates(generator.produces);
        const consumes = normalizeRates(generator.consumes);
        const nextPurchaseReadyAtStep = generator.nextPurchaseReadyAtStep ?? step + 1;
        const view = Object.freeze({
            id: generator.id,
            displayName: generator.displayName ?? generator.id,
            owned: Number.isFinite(generator.owned) ? generator.owned : 0,
            isUnlocked: Boolean(generator.isUnlocked),
            isVisible: Boolean(generator.isVisible),
            costs: quote,
            produces,
            consumes,
            nextPurchaseReadyAtStep,
        });
        views.push(view);
    }
    return Object.freeze(views);
}
function createUpgradeViews(upgrades, evaluator) {
    if (!upgrades || upgrades.length === 0) {
        return EMPTY_ARRAY;
    }
    const views = [];
    for (const upgrade of upgrades) {
        const quote = evaluateUpgradeQuote(evaluator, upgrade.id);
        const costs = quote?.costs ??
            upgrade.costs ??
            EMPTY_ARRAY;
        const normalizedCosts = normalizeUpgradeCosts(costs);
        const status = quote?.status ?? upgrade.status ?? 'locked';
        const view = Object.freeze({
            id: upgrade.id,
            displayName: upgrade.displayName ?? upgrade.id,
            status,
            costs: normalizedCosts.length > 0 ? normalizedCosts : undefined,
            unlockHint: upgrade.unlockHint,
            isVisible: Boolean(upgrade.isVisible),
        });
        views.push(view);
    }
    return Object.freeze(views);
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
function evaluateGeneratorCosts(evaluator, generatorId) {
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
    return normalizeGeneratorCosts(quote.costs);
}
function normalizeGeneratorCosts(costs) {
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
        views.push(Object.freeze({
            resourceId: cost.resourceId,
            amount,
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
function normalizeUpgradeCosts(costs) {
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
        views.push(Object.freeze({
            resourceId: cost.resourceId,
            amount,
        }));
    }
    return views.length > 0
        ? Object.freeze(views)
        : EMPTY_ARRAY;
}
//# sourceMappingURL=progression.js.map