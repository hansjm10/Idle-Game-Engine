import { useGameEngine } from './hooks/useGameEngine.js';
import { ResourcePanel } from './components/ResourcePanel.js';
import { GeneratorPanel } from './components/GeneratorPanel.js';

export function App() {
  const { state, buyGenerator } = useGameEngine();

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
      </header>

      <main className="max-w-6xl mx-auto space-y-6">
        <ResourcePanel resources={state.resources} />
        <GeneratorPanel
          generators={state.generators}
          resources={state.resources}
          onBuy={buyGenerator}
        />
      </main>
    </div>
  );
}
