import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startShellDesktopMcpGateway } from './mcp-gateway.js';
import { startShellDesktopMcpServer } from './mcp-server.js';
import type { WindowMcpController } from './window-tools.js';

async function readResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

const buildInitializeRequestBody = (): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'shell-desktop-test-client',
        version: '1.0.0',
      },
    },
  });

describe('shell-desktop MCP gateway', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  });

  it('rejects non-http backend URLs', async () => {
    await expect(startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'https://127.0.0.1:8571/mcp/sse',
    })).rejects.toThrow(/protocol/i);
  });

  it('rejects non-loopback backend URLs', async () => {
    await expect(startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'http://example.com:8571/mcp/sse',
    })).rejects.toThrow(/loopback/i);
  });

  it('accepts bracketed IPv6 loopback backend URLs', async () => {
    const gateway = await startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'http://[::1]:8571/mcp/sse',
      proxyTimeoutMs: 50,
    });
    closers.push(gateway.close);
    expect(gateway.url.protocol).toBe('http:');
  });

  it('supports initialize with application/json when backend is offline', async () => {
    const gateway = await startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'http://127.0.0.1:1/mcp/sse',
      proxyTimeoutMs: 50,
    });
    closers.push(gateway.close);

    const port = Number.parseInt(gateway.url.port, 10);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: gateway.url.pathname,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
        },
        resolve,
      );

      request.on('error', reject);
      request.write(buildInitializeRequestBody());
      request.end();
    });

    const body = await readResponseBody(response);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const payload = JSON.parse(body) as {
      result?: {
        serverInfo?: { name?: string };
      };
    };
    expect(payload.result?.serverInfo?.name).toBe('idle-engine-shell-desktop-gateway');
  });

  it('returns fallback tools and health=false while backend is offline', async () => {
    const gateway = await startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'http://127.0.0.1:1/mcp/sse',
      proxyTimeoutMs: 50,
    });
    closers.push(gateway.close);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(gateway.url);
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain('health');
    expect(toolNames).toContain('sim.status');
    expect(toolNames).toContain('window.resize');

    const healthRaw = await client.callTool({ name: 'health', arguments: {} }, CallToolResultSchema);
    const health = CallToolResultSchema.parse(healthRaw);
    expect(health.content[0]).toMatchObject({ type: 'text' });
    const healthContent = health.content[0];
    if (healthContent?.type !== 'text') {
      throw new Error('Expected text content for health tool');
    }
    const healthPayload = JSON.parse(healthContent.text) as { ok?: unknown; backendReachable?: unknown };
    expect(healthPayload.ok).toBe(false);
    expect(healthPayload.backendReachable).toBe(false);

    const unavailableRaw = await client.callTool(
      { name: 'window.resize', arguments: { width: 640, height: 480 } },
      CallToolResultSchema,
    );
    const unavailable = CallToolResultSchema.parse(unavailableRaw);
    expect(unavailable.isError).toBe(true);

    await client.close();
  });

  it('proxies tool calls when backend server is running', async () => {
    const resizeSpy = vi.fn<(width: number, height: number) => ReturnType<WindowMcpController['resize']>>(
      (width, height) => ({
        bounds: { x: 0, y: 0, width, height },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
    );

    const backend = await startShellDesktopMcpServer({
      port: 0,
      window: {
        getInfo: () => ({
          bounds: { x: 0, y: 0, width: 1200, height: 800 },
          url: 'app://idle-engine',
          devToolsOpen: false,
        }),
        resize: resizeSpy,
        setDevTools: () => ({ devToolsOpen: false }),
        captureScreenshotPng: async () => Buffer.from([1, 2, 3]),
      },
    });
    closers.push(backend.close);

    const gateway = await startShellDesktopMcpGateway({
      port: 0,
      targetUrl: backend.url,
      proxyTimeoutMs: 200,
    });
    closers.push(gateway.close);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(gateway.url);
    await client.connect(transport);

    const rawResult = await client.callTool(
      {
        name: 'window.resize',
        arguments: { width: 800, height: 600 },
      },
      CallToolResultSchema,
    );
    const result = CallToolResultSchema.parse(rawResult);
    expect(result.isError).not.toBe(true);
    expect(resizeSpy).toHaveBeenCalledWith(800, 600);

    const healthRaw = await client.callTool({ name: 'health', arguments: {} }, CallToolResultSchema);
    const health = CallToolResultSchema.parse(healthRaw);
    const healthContent = health.content[0];
    if (healthContent?.type !== 'text') {
      throw new Error('Expected text content for health tool');
    }
    const healthPayload = JSON.parse(healthContent.text) as { ok?: unknown };
    expect(healthPayload.ok).toBe(true);

    await client.close();
  });

  it('accepts connections on /mcp alias path', async () => {
    const gateway = await startShellDesktopMcpGateway({
      port: 0,
      targetUrl: 'http://127.0.0.1:1/mcp/sse',
      proxyTimeoutMs: 50,
    });
    closers.push(gateway.close);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', gateway.url));
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('health');

    await client.close();
  });
});
