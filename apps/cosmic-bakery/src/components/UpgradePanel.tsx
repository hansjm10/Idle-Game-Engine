interface UpgradePanelProps {
  upgrades: Map<string, { purchased: number; unlocked: boolean }>;
  resources: Map<string, { amount: number; capacity: number | null; rate: number }>;
  onBuy: (id: string) => void;
}

const UPGRADE_INFO: Record<string, { name: string; description: string; cost: { resource: string; base: number } }> = {
  'cosmic-bakery.better-whisks': { name: 'Better Whisks', description: '+25% Hand Mixer rate', cost: { resource: 'cosmic-bakery.flour', base: 50 } },
  'cosmic-bakery.refined-sugar': { name: 'Refined Sugar', description: '+25% Sugar Mill rate', cost: { resource: 'cosmic-bakery.flour', base: 75 } },
  'cosmic-bakery.elastic-gluten': { name: 'Elastic Gluten', description: '+50% Kneading Station rate', cost: { resource: 'cosmic-bakery.flour', base: 100 } },
  'cosmic-bakery.bulk-mixing': { name: 'Bulk Mixing', description: '-10% Hand Mixer cost', cost: { resource: 'cosmic-bakery.flour', base: 150 } },
  'cosmic-bakery.double-batch': { name: 'Double Batch', description: '+15% All Tier 1 rate', cost: { resource: 'cosmic-bakery.flour', base: 200 } },
  'cosmic-bakery.stellar-alignment': { name: 'Stellar Alignment', description: '+40% Star Collector rate', cost: { resource: 'cosmic-bakery.dough', base: 200 } },
  'cosmic-bakery.lunar-cycle-sync': { name: 'Lunar Cycle Sync', description: '+35% Moonbeam Churn rate', cost: { resource: 'cosmic-bakery.stardust', base: 50 } },
  'cosmic-bakery.enchantment-mastery': { name: 'Enchantment Mastery', description: '+50% Enchanted Oven rate', cost: { resource: 'cosmic-bakery.stardust', base: 100 } },
  'cosmic-bakery.cosmic-resonance': { name: 'Cosmic Resonance', description: '+20% All Tier 2 rate', cost: { resource: 'cosmic-bakery.moon-cream', base: 150 } },
  'cosmic-bakery.void-stabilizers': { name: 'Void Stabilizers', description: '+30% Void Portal rate', cost: { resource: 'cosmic-bakery.void-essence', base: 50 } },
  'cosmic-bakery.reality-threads': { name: 'Reality Threads', description: '+25% Reality Forge rate', cost: { resource: 'cosmic-bakery.reality-dough', base: 25 } },
  'cosmic-bakery.remembered-recipes': { name: 'Remembered Recipes', description: '+50 Flour capacity', cost: { resource: 'cosmic-bakery.ascension-stars', base: 1 } },
  'cosmic-bakery.timeless-techniques': { name: 'Timeless Techniques', description: '+10% Tier 1 rate', cost: { resource: 'cosmic-bakery.ascension-stars', base: 3 } },
  'cosmic-bakery.celestial-blessing': { name: 'Celestial Blessing', description: '+5% All generators', cost: { resource: 'cosmic-bakery.ascension-stars', base: 5 } },
};

const UPGRADE_ORDER = Object.keys(UPGRADE_INFO);

function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

export function UpgradePanel({ upgrades, resources, onBuy }: UpgradePanelProps) {
  const availableUpgrades = UPGRADE_ORDER.filter(id => {
    const u = upgrades.get(id);
    return u?.unlocked && u.purchased === 0;
  });

  if (availableUpgrades.length === 0) {
    return null;
  }

  return (
    <div className="bg-cosmic-900/50 rounded-lg p-4 backdrop-blur-sm border border-cosmic-700">
      <h2 className="text-gold-400 font-display text-xl mb-3">Upgrades</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {availableUpgrades.map(id => {
          const info = UPGRADE_INFO[id];
          const currency = resources.get(info.cost.resource);
          const canAfford = currency && currency.amount >= info.cost.base;

          return (
            <div key={id} className="bg-cosmic-800/60 rounded p-3 flex items-center justify-between">
              <div>
                <div className="text-cosmic-100 font-semibold">{info.name}</div>
                <div className="text-cosmic-400 text-sm">{info.description}</div>
              </div>
              <button
                onClick={() => onBuy(id)}
                disabled={!canAfford}
                className={`px-3 py-1.5 rounded text-sm font-semibold transition-all ${
                  canAfford
                    ? 'bg-purple-600 text-white hover:bg-purple-500'
                    : 'bg-cosmic-700 text-cosmic-500 cursor-not-allowed'
                }`}
              >
                {formatNumber(info.cost.base)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
