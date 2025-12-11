interface GeneratorPanelProps {
  generators: Map<string, { level: number; unlocked: boolean }>;
  resources: Map<string, { amount: number; capacity: number | null; rate: number }>;
  onBuy: (id: string) => void;
}

const GENERATOR_INFO: Record<string, { name: string; produces: string; cost: { resource: string; base: number; growth: number } }> = {
  'cosmic-bakery.hand-mixer': { name: 'Hand Mixer', produces: 'Flour', cost: { resource: 'cosmic-bakery.flour', base: 10, growth: 1.15 } },
  'cosmic-bakery.sugar-mill': { name: 'Sugar Mill', produces: 'Sugar', cost: { resource: 'cosmic-bakery.flour', base: 25, growth: 1.2 } },
  'cosmic-bakery.kneading-station': { name: 'Kneading Station', produces: 'Dough', cost: { resource: 'cosmic-bakery.flour', base: 50, growth: 1.25 } },
  'cosmic-bakery.star-collector': { name: 'Star Collector', produces: 'Stardust', cost: { resource: 'cosmic-bakery.dough', base: 100, growth: 1.3 } },
  'cosmic-bakery.moonbeam-churn': { name: 'Moonbeam Churn', produces: 'Moon Cream', cost: { resource: 'cosmic-bakery.stardust', base: 50, growth: 1.35 } },
  'cosmic-bakery.enchanted-oven': { name: 'Enchanted Oven', produces: 'Pastries', cost: { resource: 'cosmic-bakery.stardust', base: 100, growth: 1.4 } },
  'cosmic-bakery.void-portal': { name: 'Void Portal', produces: 'Void Essence', cost: { resource: 'cosmic-bakery.enchanted-pastries', base: 200, growth: 1.45 } },
  'cosmic-bakery.reality-forge': { name: 'Reality Forge', produces: 'Reality Dough', cost: { resource: 'cosmic-bakery.void-essence', base: 100, growth: 1.5 } },
  'cosmic-bakery.celestial-bakery': { name: 'Celestial Bakery', produces: 'Stars', cost: { resource: 'cosmic-bakery.reality-dough', base: 50, growth: 1.6 } },
};

const GENERATOR_ORDER = Object.keys(GENERATOR_INFO);

function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

function calculateCost(base: number, growth: number, level: number): number {
  return Math.floor(base * Math.pow(growth, level));
}

export function GeneratorPanel({ generators, resources, onBuy }: GeneratorPanelProps) {
  const visibleGenerators = GENERATOR_ORDER.filter(id => {
    const g = generators.get(id);
    return g?.unlocked;
  });

  if (visibleGenerators.length === 0) {
    return null;
  }

  return (
    <div className="bg-cosmic-900/50 rounded-lg p-4 backdrop-blur-sm border border-cosmic-700">
      <h2 className="text-gold-400 font-display text-xl mb-3">Generators</h2>
      <div className="space-y-2">
        {visibleGenerators.map(id => {
          const g = generators.get(id)!;
          const info = GENERATOR_INFO[id];
          const cost = calculateCost(info.cost.base, info.cost.growth, g.level);
          const currency = resources.get(info.cost.resource);
          const canAfford = currency && currency.amount >= cost;

          return (
            <div key={id} className="bg-cosmic-800/60 rounded p-3 flex items-center justify-between">
              <div>
                <div className="text-cosmic-100 font-semibold">{info.name}</div>
                <div className="text-cosmic-400 text-sm">
                  Level {g.level} • Produces {info.produces}
                </div>
              </div>
              <button
                onClick={() => onBuy(id)}
                disabled={!canAfford}
                className={`px-4 py-2 rounded font-semibold transition-all ${
                  canAfford
                    ? 'bg-gold-500 text-cosmic-950 hover:bg-gold-400'
                    : 'bg-cosmic-700 text-cosmic-500 cursor-not-allowed'
                }`}
              >
                {formatNumber(cost)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
