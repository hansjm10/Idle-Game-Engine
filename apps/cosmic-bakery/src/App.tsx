import { useState } from 'react';
import { useGameEngine } from './hooks/useGameEngine.js';
import { ResourcePanel } from './components/ResourcePanel.js';
import { GeneratorPanel } from './components/GeneratorPanel.js';
import { UpgradePanel } from './components/UpgradePanel.js';
import { AchievementPanel } from './components/AchievementPanel.js';
import { PrestigePanel } from './components/PrestigePanel.js';
import { SettingsPanel } from './components/SettingsPanel.js';

type Tab = 'game' | 'upgrades' | 'achievements' | 'settings';

export function App() {
  const { state, buyGenerator, buyUpgrade, saveGame, resetGame, triggerPrestige } = useGameEngine();
  const [activeTab, setActiveTab] = useState<Tab>('game');

  if (!state.ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-gold-400 font-display text-4xl animate-pulse mb-4">
            Cosmic Bakery
          </div>
          <div className="text-cosmic-300">Loading...</div>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'game', label: 'Bakery' },
    { id: 'upgrades', label: 'Upgrades' },
    { id: 'achievements', label: 'Achievements' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="text-center py-6 bg-cosmic-950/50 backdrop-blur-sm border-b border-cosmic-700">
        <h1 className="font-display text-4xl md:text-5xl text-gold-400 drop-shadow-lg">
          Cosmic Bakery
        </h1>
        <p className="text-cosmic-300 mt-1 text-sm">
          Bake your way across the cosmos!
        </p>
      </header>

      <nav className="bg-cosmic-900/50 border-b border-cosmic-700">
        <div className="max-w-6xl mx-auto flex">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-6 py-3 font-semibold transition-colors ${
                activeTab === tab.id
                  ? 'text-gold-400 border-b-2 border-gold-400 bg-cosmic-800/50'
                  : 'text-cosmic-400 hover:text-cosmic-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="flex-1 p-4 md:p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {activeTab === 'game' && (
            <>
              <PrestigePanel
                resources={state.resources}
                generators={state.generators}
                onPrestige={triggerPrestige}
              />
              <ResourcePanel resources={state.resources} />
              <GeneratorPanel
                generators={state.generators}
                resources={state.resources}
                onBuy={buyGenerator}
              />
            </>
          )}

          {activeTab === 'upgrades' && (
            <UpgradePanel
              upgrades={state.upgrades}
              resources={state.resources}
              onBuy={buyUpgrade}
            />
          )}

          {activeTab === 'achievements' && (
            <AchievementPanel achievements={state.achievements} />
          )}

          {activeTab === 'settings' && (
            <SettingsPanel onSave={saveGame} onReset={resetGame} />
          )}
        </div>
      </main>

      <footer className="text-center py-4 text-cosmic-500 text-sm border-t border-cosmic-800">
        Cosmic Bakery v0.1.0 • Built with Idle-Game-Engine
      </footer>
    </div>
  );
}
