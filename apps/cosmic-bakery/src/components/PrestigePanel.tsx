interface PrestigePanelProps {
  resources: Map<string, { amount: number; capacity: number | null; rate: number }>;
  generators: Map<string, { level: number; unlocked: boolean }>;
  onPrestige: () => void;
}

export function PrestigePanel({ resources, generators, onPrestige }: PrestigePanelProps) {
  const pastries = resources.get('cosmic-bakery.enchanted-pastries')?.amount ?? 0;
  const ovens = generators.get('cosmic-bakery.enchanted-oven')?.level ?? 0;
  const ascensionStars = resources.get('cosmic-bakery.ascension-stars')?.amount ?? 0;

  const canPrestige = pastries >= 500 && ovens >= 10;
  const reward = canPrestige ? Math.max(1, Math.min(1000, Math.floor(pastries / 100))) : 0;

  if (!canPrestige && ascensionStars === 0) {
    return null;
  }

  return (
    <div className="bg-gradient-to-r from-purple-900/70 to-cosmic-900/70 rounded-lg p-4 backdrop-blur-sm border border-purple-500">
      <h2 className="text-purple-300 font-display text-xl mb-3">Celestial Ascension</h2>

      {ascensionStars > 0 && (
        <div className="mb-4 text-purple-200">
          You have <span className="text-yellow-400 font-bold">{ascensionStars}</span> Ascension Stars
        </div>
      )}

      <div className="space-y-2 mb-4">
        <div className="flex justify-between text-sm">
          <span className={pastries >= 500 ? 'text-green-400' : 'text-cosmic-400'}>
            Enchanted Pastries: {pastries.toFixed(0)}/500
          </span>
          <span>{pastries >= 500 ? '✓' : '✗'}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className={ovens >= 10 ? 'text-green-400' : 'text-cosmic-400'}>
            Enchanted Ovens: {ovens}/10
          </span>
          <span>{ovens >= 10 ? '✓' : '✗'}</span>
        </div>
      </div>

      {canPrestige && (
        <div className="text-center">
          <div className="text-yellow-400 mb-2">
            Ascend to gain <span className="font-bold">{reward}</span> Ascension Stars!
          </div>
          <button
            onClick={onPrestige}
            className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold rounded-lg hover:from-purple-500 hover:to-pink-500 transition-all shadow-lg"
          >
            Ascend
          </button>
        </div>
      )}
    </div>
  );
}
