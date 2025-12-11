import { useGameEngine } from './hooks/useGameEngine.js';
import { ResourcePanel } from './components/ResourcePanel.js';
import { GeneratorPanel } from './components/GeneratorPanel.js';
import { UpgradePanel } from './components/UpgradePanel.js';
import { AchievementPanel } from './components/AchievementPanel.js';
import { PrestigePanel } from './components/PrestigePanel.js';

export function App() {
  const { state, buyGenerator, buyUpgrade, saveGame, resetGame, triggerPrestige } = useGameEngine();

  if (!state.ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gold-400 font-display text-2xl animate-pulse">
          Loading Cosmic Bakery...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4">
      <header className="text-center mb-8">
        <h1 className="font-display text-5xl text-gold-400 drop-shadow-lg">
          Cosmic Bakery
        </h1>
        <p className="text-cosmic-200 mt-2">
          Bake your way across the cosmos!
        </p>
        <div className="mt-4 space-x-4">
          <button
            onClick={saveGame}
            className="px-4 py-1 text-sm bg-cosmic-700 text-cosmic-200 rounded hover:bg-cosmic-600"
          >
            Save
          </button>
          <button
            onClick={resetGame}
            className="px-4 py-1 text-sm bg-red-900/50 text-red-300 rounded hover:bg-red-800/50"
          >
            Reset
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto space-y-6">
        <PrestigePanel
          resources={state.resources}
          generators={state.generators}
          onPrestige={triggerPrestige}
        />
        <ResourcePanel resources={state.resources} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <GeneratorPanel
            generators={state.generators}
            resources={state.resources}
            onBuy={buyGenerator}
          />
          <UpgradePanel
            upgrades={state.upgrades}
            resources={state.resources}
            onBuy={buyUpgrade}
          />
        </div>
        <AchievementPanel achievements={state.achievements} />
      </main>
    </div>
  );
}
