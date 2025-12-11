interface AchievementPanelProps {
  achievements: Map<string, { earned: boolean }>;
}

const ACHIEVEMENT_INFO: Record<string, { name: string; description: string; tier: 'bronze' | 'silver' | 'gold' }> = {
  'cosmic-bakery.first-batch': { name: 'First Batch', description: 'Purchase your first hand mixer', tier: 'bronze' },
  'cosmic-bakery.sugar-rush': { name: 'Sugar Rush', description: 'Unlock sugar production', tier: 'bronze' },
  'cosmic-bakery.rising-star': { name: 'Rising Star', description: 'Unlock stardust production', tier: 'bronze' },
  'cosmic-bakery.enchanted-chef': { name: 'Enchanted Chef', description: 'Create your first enchanted pastry', tier: 'silver' },
  'cosmic-bakery.void-walker': { name: 'Void Walker', description: 'Harness the power of void essence', tier: 'silver' },
  'cosmic-bakery.reality-baker': { name: 'Reality Baker', description: 'Forge your first reality dough', tier: 'gold' },
  'cosmic-bakery.flour-power': { name: 'Flour Power', description: 'Own 10 hand mixers', tier: 'bronze' },
  'cosmic-bakery.sweet-empire': { name: 'Sweet Empire', description: 'Own 10 sugar mills', tier: 'bronze' },
  'cosmic-bakery.master-kneader': { name: 'Master Kneader', description: 'Own 10 kneading stations', tier: 'silver' },
  'cosmic-bakery.stargazer': { name: 'Stargazer', description: 'Own 5 star collectors', tier: 'silver' },
  'cosmic-bakery.moon-child': { name: 'Moon Child', description: 'Own 5 moonbeam churns', tier: 'gold' },
  'cosmic-bakery.oven-master': { name: 'Oven Master', description: 'Own 10 enchanted ovens', tier: 'gold' },
};

const TIER_COLORS = {
  bronze: 'text-amber-600 border-amber-600',
  silver: 'text-gray-300 border-gray-400',
  gold: 'text-yellow-400 border-yellow-500',
};

const TIER_BG = {
  bronze: 'bg-amber-900/30',
  silver: 'bg-gray-700/30',
  gold: 'bg-yellow-900/30',
};

export function AchievementPanel({ achievements }: AchievementPanelProps) {
  const earnedAchievements = Object.entries(ACHIEVEMENT_INFO).filter(([id]) =>
    achievements.get(id)?.earned
  );

  if (earnedAchievements.length === 0) {
    return null;
  }

  return (
    <div className="bg-cosmic-900/50 rounded-lg p-4 backdrop-blur-sm border border-cosmic-700">
      <h2 className="text-gold-400 font-display text-xl mb-3">
        Achievements ({earnedAchievements.length}/{Object.keys(ACHIEVEMENT_INFO).length})
      </h2>
      <div className="flex flex-wrap gap-2">
        {earnedAchievements.map(([id, info]) => (
          <div
            key={id}
            className={`rounded-lg px-3 py-2 border ${TIER_COLORS[info.tier]} ${TIER_BG[info.tier]}`}
            title={info.description}
          >
            <span className="font-semibold">{info.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
