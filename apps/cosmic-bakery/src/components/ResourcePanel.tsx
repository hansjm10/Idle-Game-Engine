interface ResourcePanelProps {
  resources: Map<string, { amount: number; capacity: number | null; rate: number }>;
}

const RESOURCE_DISPLAY_NAMES: Record<string, string> = {
  'cosmic-bakery.flour': 'Flour',
  'cosmic-bakery.sugar': 'Sugar',
  'cosmic-bakery.dough': 'Dough',
  'cosmic-bakery.stardust': 'Stardust',
  'cosmic-bakery.moon-cream': 'Moon Cream',
  'cosmic-bakery.enchanted-pastries': 'Enchanted Pastries',
  'cosmic-bakery.void-essence': 'Void Essence',
  'cosmic-bakery.reality-dough': 'Reality Dough',
  'cosmic-bakery.ascension-stars': 'Ascension Stars',
  'cosmic-bakery.celestial-gems': 'Celestial Gems',
  'cosmic-bakery.cosmic-flour': 'Cosmic Flour',
};

const TIER_ORDER = [
  'cosmic-bakery.flour',
  'cosmic-bakery.sugar',
  'cosmic-bakery.dough',
  'cosmic-bakery.stardust',
  'cosmic-bakery.moon-cream',
  'cosmic-bakery.enchanted-pastries',
  'cosmic-bakery.void-essence',
  'cosmic-bakery.reality-dough',
  'cosmic-bakery.ascension-stars',
  'cosmic-bakery.celestial-gems',
  'cosmic-bakery.cosmic-flour',
];

function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(1);
}

export function ResourcePanel({ resources }: ResourcePanelProps) {
  const visibleResources = TIER_ORDER.filter(id => {
    const r = resources.get(id);
    return r && r.amount > 0;
  });

  if (visibleResources.length === 0) {
    return null;
  }

  return (
    <div className="bg-cosmic-900/50 rounded-lg p-4 backdrop-blur-sm border border-cosmic-700">
      <h2 className="text-gold-400 font-display text-xl mb-3">Resources</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {visibleResources.map(id => {
          const r = resources.get(id)!;
          const name = RESOURCE_DISPLAY_NAMES[id] || id;
          const pct = r.capacity ? Math.min(100, (r.amount / r.capacity) * 100) : null;

          return (
            <div key={id} className="bg-cosmic-800/60 rounded p-3">
              <div className="text-cosmic-200 text-sm font-semibold">{name}</div>
              <div className="text-gold-300 text-lg font-bold">
                {formatNumber(r.amount)}
                {r.capacity && <span className="text-cosmic-400 text-sm">/{formatNumber(r.capacity)}</span>}
              </div>
              {r.rate !== 0 && (
                <div className={`text-xs ${r.rate > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {r.rate > 0 ? '+' : ''}{formatNumber(r.rate)}/s
                </div>
              )}
              {pct !== null && (
                <div className="mt-1 h-1 bg-cosmic-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gold-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
