const output = document.querySelector<HTMLPreElement>('#output');

async function run(): Promise<void> {
  if (!output) {
    return;
  }

  try {
    const pong = await window.idleEngine.ping('hello');
    output.textContent = `IPC ok: ${pong}`;
  } catch (error: unknown) {
    output.textContent = `IPC error: ${String(error)}`;
  }
}

void run();

