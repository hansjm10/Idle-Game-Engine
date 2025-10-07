import { useEffect, useMemo, useState } from 'react';
import { IdleEngineRuntime } from '@idle-engine/core';

export function App() {
  const engine = useMemo(() => new IdleEngineRuntime(), []);
  const [, setTicks] = useState(0);

  useEffect(() => {
    let animationFrame: number;
    let lastTimestamp = performance.now();

    const loop = (now: number) => {
      const delta = now - lastTimestamp;
      lastTimestamp = now;
      engine.tick(delta);
      setTicks((tick) => tick + 1);
      animationFrame = requestAnimationFrame(loop);
    };

    animationFrame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrame);
  }, [engine]);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Idle Engine Shell</h1>
      <p>
        Placeholder web shell wired to the runtime tick loop. UI integration will
        render resources, upgrades, and social overlays once systems are in place.
      </p>
    </main>
  );
}
