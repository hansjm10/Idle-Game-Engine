import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromShellDesktop = createRequire(new URL('../../packages/shell-desktop/package.json', import.meta.url));

const clientModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/client/index.js');
const transportModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
const typesModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/types.js');

const { Client } = await import(pathToFileURL(clientModulePath).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(transportModulePath).href);
const { CallToolResultSchema } = await import(pathToFileURL(typesModulePath).href);

const outputDirectory = path.resolve(
  process.argv[2] ?? 'docs/evidence/shell-demo-gap-audit/screens',
);
const port = process.env.IDLE_ENGINE_MCP_PORT ?? '8570';
const endpoint = new URL(`http://127.0.0.1:${port}/mcp/sse`);

const client = new Client({
  name: 'shell-desktop-gap-audit',
  version: '1.0.0',
});

const records = [];

function summarizeText(text, maxLength = 240) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function extractToolErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return parsed.error;
      }
      if (typeof parsed.message === 'string' && parsed.message.length > 0) {
        return parsed.message;
      }
    }
  } catch {
    // Fall back to raw text when tool output is not JSON.
  }

  return text;
}

async function callToolJson(name, args = {}) {
  const result = await client.callTool(
    {
      name,
      arguments: args,
    },
    CallToolResultSchema,
  );

  const firstContent = result.content?.[0];
  if (firstContent?.type !== 'text') {
    throw new Error(`MCP tool ${name} returned non-text content.`);
  }

  const text = firstContent.text;
  if (result.isError === true) {
    const errorMessage = summarizeText(extractToolErrorMessage(text));
    throw new Error(`MCP tool ${name} failed: ${errorMessage}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MCP tool ${name} returned invalid JSON: ${summarizeText(text)}`);
  }
}

async function setStressProfile(profile) {
  await callToolJson('sim.enqueue', {
    commands: [
      {
        type: 'DEMO_SET_STRESS_PROFILE',
        payload: { profile },
      },
    ],
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(maxAttempts = 40, intervalMs = 100) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await callToolJson('sim.status');
    if (status?.state === 'running' || status?.state === 'paused') {
      return status;
    }
    await sleep(intervalMs);
  }

  throw new Error('Timed out waiting for simulation ready state.');
}

async function stepDeterministic(steps) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await callToolJson('sim.step', { steps });
      if (result?.ok === true && result?.status) {
        return result;
      }

      const resultText = JSON.stringify(result).toLowerCase();
      if (resultText.includes('not ready')) {
        await sleep(100);
        continue;
      }

      if (resultText.includes('not running')) {
        await callToolJson('sim.start');
        await waitForReady();
        continue;
      }

      throw new Error(`sim.step returned unexpected payload: ${JSON.stringify(result)}`);
    } catch (error) {
      const message = String(error).toLowerCase();
      if (message.includes('not ready')) {
        await sleep(100);
        continue;
      }
      if (message.includes('not running')) {
        await callToolJson('sim.start');
        await waitForReady();
        continue;
      }
      throw error;
    }
  }

  throw new Error('Timed out stepping simulation.');
}

async function capture(stepId, filename, notes) {
  const screenshot = await callToolJson('window.screenshot', {
    maxBytes: 5_000_000,
  });

  if (screenshot?.ok !== true || typeof screenshot?.dataBase64 !== 'string') {
    throw new Error(`window.screenshot failed: ${JSON.stringify(screenshot)}`);
  }

  const targetPath = path.join(outputDirectory, filename);
  await writeFile(targetPath, Buffer.from(screenshot.dataBase64, 'base64'));

  const simStatus = await callToolJson('sim.status');

  records.push({
    stepId,
    filename,
    notes,
    simStatus,
    bytes: screenshot.bytes,
  });

  console.log(
    JSON.stringify({
      event: 'screenshot_saved',
      stepId,
      file: targetPath,
      bytes: screenshot.bytes,
      simStatus,
      notes,
    }),
  );
}

async function enqueueCollectBurst(count) {
  const commands = Array.from({ length: count }, () => ({
    type: 'COLLECT_RESOURCE',
    payload: {
      resourceId: 'demo',
      amount: 1,
    },
  }));

  await callToolJson('sim.enqueue', { commands });
}

async function enqueuePointerCollect() {
  await callToolJson('sim.enqueue', {
    commands: [
      {
        type: 'INPUT_EVENT',
        payload: {
          schemaVersion: 1,
          event: {
            kind: 'pointer',
            intent: 'mouse-down',
            phase: 'start',
            x: 20,
            y: 20,
            button: 0,
            buttons: 1,
            pointerType: 'mouse',
            modifiers: {
              alt: false,
              ctrl: false,
              meta: false,
              shift: false,
            },
          },
        },
      },
    ],
  });
}

async function run() {
  await mkdir(outputDirectory, { recursive: true });
  await client.connect(new StreamableHTTPClientTransport(endpoint));

  await callToolJson('sim.stop');
  await callToolJson('sim.start');
  await callToolJson('sim.resume');
  await waitForReady();

  await callToolJson('window.resize', { width: 1280, height: 720 });
  await setStressProfile('baseline');
  await stepDeterministic(3);
  await capture('S01', '010-baseline-startup-1280x720.png', 'startup baseline');

  await callToolJson('window.resize', { width: 1600, height: 500 });
  await stepDeterministic(2);
  await capture('S02', '020-resize-wide-1600x500.png', 'resize wide viewport');

  await callToolJson('window.resize', { width: 1280, height: 720 });
  await callToolJson('input.controlEvent', {
    intent: 'collect',
    phase: 'start',
  });
  await enqueuePointerCollect();
  await stepDeterministic(4);
  await capture('S03', '030-input-control-and-pointer.png', 'control and pointer collect parity');

  await callToolJson('sim.pause');
  await setStressProfile('clip-stack');
  await stepDeterministic(6);
  await capture('S04', '040-pause-step-clip-stack.png', 'paused deterministic stepping with clip-stack');

  await setStressProfile('draw-burst');
  await enqueueCollectBurst(60);
  await stepDeterministic(4);
  await capture('S05', '050-draw-burst-enqueue.png', 'draw burst and command burst');

  await setStressProfile('text-wall');
  await callToolJson('asset.list', {
    path: '',
    recursive: false,
    maxEntries: 20,
  });
  await callToolJson('asset.read', {
    path: '@idle-engine/sample-pack.assets/renderer-assets.manifest.json',
    maxBytes: 200000,
  });
  await stepDeterministic(3);
  await capture('S06', '060-text-wall-asset-tools.png', 'text wall profile and asset tool checks');

  await callToolJson('sim.stop');
  await callToolJson('sim.start');
  await callToolJson('sim.resume');
  await waitForReady();
  await setStressProfile('mixed');
  await stepDeterministic(5);
  await capture('S07', '070-stop-start-mixed.png', 'stop/start lifecycle recovery to mixed profile');

  await callToolJson('sim.resume');
  await stepDeterministic(120);
  await capture('S08', '080-long-run-drift-spot-check.png', 'long run drift spot-check');

  const reportPath = path.join(outputDirectory, 'capture-report.json');
  await writeFile(reportPath, JSON.stringify({ endpoint: endpoint.toString(), records }, null, 2));

  console.log(JSON.stringify({ event: 'audit_complete', report: reportPath, screenshotCount: records.length }));

  await client.close();
}

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({ event: 'audit_failed', message: String(error) }));
  try {
    await client.close();
  } catch {
    // no-op
  }
  process.exitCode = 1;
}
