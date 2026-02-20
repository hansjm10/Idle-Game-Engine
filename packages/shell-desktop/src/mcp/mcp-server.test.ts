import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  isShellDesktopMcpServerEnabled,
  maybeStartShellDesktopMcpServer,
  startShellDesktopMcpServer,
} from './mcp-server.js';
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

describe('shell-desktop MCP server', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  it('returns disabled state unless MCP is explicitly enabled', () => {
    expect(isShellDesktopMcpServerEnabled(['node', 'app.js'], {})).toBe(false);
    expect(isShellDesktopMcpServerEnabled(['node', 'app.js'], {
      IDLE_ENGINE_ENABLE_MCP_SERVER: '1',
    })).toBe(true);
    expect(isShellDesktopMcpServerEnabled(['node', 'app.js', '--enable-mcp-server'], {})).toBe(true);
  });

  it('does not start when maybeStart is called without enablement', async () => {
    const server = await maybeStartShellDesktopMcpServer({
      argv: ['node', 'app.js'],
      env: { NODE_ENV: 'test' },
    });

    expect(server).toBeUndefined();
  });

  it('starts when enabled via argv and supports ephemeral explicit ports', async () => {
    const server = await maybeStartShellDesktopMcpServer({
      argv: ['node', 'app.js', '--enable-mcp-server', '--mcp-port=0'],
      env: { NODE_ENV: 'test' },
    });

    if (!server) {
      throw new Error('Expected maybeStart to return a running server');
    }

    servers.push(server);
    expect(server.url.hostname).toBe('127.0.0.1');
    expect(server.url.pathname).toBe('/mcp/sse');
  });

  it('falls back to the next available port when default MCP port is busy', async () => {
    const createBusyServer = async (port: number): Promise<{
      server: http.Server;
      listening: boolean;
    }> => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('busy');
      });

      let listening = false;
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: unknown) => {
          const code = error instanceof Error && 'code' in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
          if (code === 'EADDRINUSE') {
            resolve();
            return;
          }
          reject(error);
        });

        server.listen({ host: '127.0.0.1', port }, () => {
          listening = true;
          resolve();
        });
      });

      return { server, listening };
    };

    const blockerDefault = await createBusyServer(8570);
    const blockerNext = await createBusyServer(8571);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const server = await maybeStartShellDesktopMcpServer({
        argv: ['node', 'app.js', '--enable-mcp-server'],
        env: { NODE_ENV: 'production' },
      });

      if (!server) {
        throw new Error('Expected maybeStart to return a running server');
      }

      servers.push(server);
      const selectedPort = Number.parseInt(server.url.port, 10);
      expect(selectedPort).toBeGreaterThanOrEqual(8572);
      expect(warnSpy).toHaveBeenCalledWith(
        `[shell-desktop] MCP port 8570 is busy; using ${selectedPort} instead.`,
      );
      expect(logSpy).toHaveBeenCalledWith(
        `[shell-desktop] MCP server listening at ${server.url.toString()}`,
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();

      if (blockerDefault.listening) {
        await new Promise<void>((resolve, reject) => {
          blockerDefault.server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }

      if (blockerNext.listening) {
        await new Promise<void>((resolve, reject) => {
          blockerNext.server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });

  it('throws when an explicit MCP port is already in use', async () => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('busy');
    });

    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '127.0.0.1', port: 0 }, () => {
        blocker.off('error', reject);
        resolve();
      });
    });

    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected blocker server to expose a bound TCP address');
    }

    const busyPort = String(address.port);

    try {
      await expect(maybeStartShellDesktopMcpServer({
        argv: ['node', 'app.js', '--enable-mcp-server'],
        env: {
          NODE_ENV: 'test',
          IDLE_ENGINE_MCP_PORT: busyPort,
        },
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('closes server resources when startup fails during listen', async () => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('busy');
    });

    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '127.0.0.1', port: 0 }, () => {
        blocker.off('error', reject);
        resolve();
      });
    });

    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected blocker server to expose a bound TCP address');
    }

    const serverCloseSpy = vi.spyOn(McpServer.prototype, 'close');
    const transportCloseSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    try {
      await expect(startShellDesktopMcpServer({ port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(serverCloseSpy).toHaveBeenCalled();
      expect(transportCloseSpy).toHaveBeenCalled();
    } finally {
      serverCloseSpy.mockRestore();
      transportCloseSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('rejects invalid explicit MCP ports', async () => {
    await expect(maybeStartShellDesktopMcpServer({
      argv: ['node', 'app.js', '--enable-mcp-server'],
      env: {
        NODE_ENV: 'test',
        IDLE_ENGINE_MCP_PORT: '70000',
      },
    })).rejects.toThrow('Invalid MCP port: 70000');
  });

  it('exposes the health tool over streamable HTTP', async () => {
    const server = await startShellDesktopMcpServer({ port: 0 });
    servers.push(server);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(server.url);
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('health');

    const rawResult = await client.callTool({ name: 'health', arguments: {} }, CallToolResultSchema);
    const result = CallToolResultSchema.parse(rawResult);
    expect(result.content[0]).toMatchObject({ type: 'text' });

    await client.close();
  });

  it('exposes diagnostics tools when diagnostics controllers are provided', async () => {
    const server = await startShellDesktopMcpServer({
      port: 0,
      diagnostics: {
        getRendererStatus: () => ({
          outputText: 'IPC ok\nSim running\nWebGPU ok.',
          rendererState: 'running',
          updatedAtMs: 1234,
        }),
        getLogs: () => ([
          {
            id: 1,
            timestampMs: 1234,
            source: 'renderer',
            subsystem: 'webgpu',
            severity: 'info',
            message: 'WebGPU initialized',
          },
        ]),
        getWebGpuHealth: () => ({
          status: 'ok',
          lastEventTimestampMs: 1234,
        }),
      },
    });
    servers.push(server);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(server.url);
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain('renderer.status');
    expect(toolNames).toContain('logs.tail');
    expect(toolNames).toContain('logs.since');
    expect(toolNames).toContain('probe.webgpuHealth');

    const probeRaw = await client.callTool({ name: 'probe.webgpuHealth', arguments: {} }, CallToolResultSchema);
    const probeResult = CallToolResultSchema.parse(probeRaw);
    const probeContent = probeResult.content[0];
    if (probeContent?.type !== 'text') {
      throw new Error('Expected text content for probe.webgpuHealth');
    }
    const probePayload = JSON.parse(probeContent.text) as { ok?: unknown; health?: { status?: unknown } };
    expect(probePayload.ok).toBe(true);
    expect(probePayload.health?.status).toBe('ok');

    await client.close();
  });

  it('accepts initialization requests that only advertise application/json', async () => {
    const server = await startShellDesktopMcpServer({ port: 0 });
    servers.push(server);

    const port = Number.parseInt(server.url.port, 10);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: server.url.pathname,
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
      result?: { protocolVersion?: string };
    };
    expect(payload.result?.protocolVersion).toBe('2025-06-18');
  });

  it('responds with 400 for malformed request URLs', async () => {
    const server = await startShellDesktopMcpServer({ port: 0 });
    servers.push(server);

    const uncaughtExceptions: unknown[] = [];
    const onUncaughtException = (error: unknown) => {
      uncaughtExceptions.push(error);
    };

      process.once('uncaughtException', onUncaughtException);

    try {
      const port = Number.parseInt(server.url.port, 10);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'GET',
            path: 'http://localhost:bad/',
          },
          resolve,
        );

        request.on('error', reject);
        request.setTimeout(1000, () => {
          request.destroy(new Error('Request timed out'));
        });
        request.end();
      });

      const body = await readResponseBody(response);

      expect(uncaughtExceptions).toHaveLength(0);
      expect(response.statusCode).toBe(400);
      expect(body).toContain('Invalid request URL');
    } finally {
      process.off('uncaughtException', onUncaughtException);
    }
  });

  it('handles POST message handler rejections without unhandled rejections', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandledRejection);

    const handleRequestOriginal = StreamableHTTPServerTransport.prototype.handleRequest;
    const handleRequestSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockImplementation(async function (this: StreamableHTTPServerTransport, request, response, parsedBody) {
        if (request.method === 'POST') {
          response.writeHead(500).end('boom');
          throw new Error('boom');
        }

        return handleRequestOriginal.call(this, request, response, parsedBody);
      });

    try {
      const server = await startShellDesktopMcpServer({ port: 0 });
      servers.push(server);

      const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(server.url);
      await client.connect(transport).catch(() => undefined);
      await client.close().catch(() => undefined);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      handleRequestSpy.mockRestore();
    }
  });

  it('closes server resources when stopped', async () => {
    const serverCloseSpy = vi.spyOn(McpServer.prototype, 'close');
    const transportCloseSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    const server = await startShellDesktopMcpServer({ port: 0 });
    await server.close();

    expect(serverCloseSpy).toHaveBeenCalled();
    expect(transportCloseSpy).toHaveBeenCalled();

    serverCloseSpy.mockRestore();
    transportCloseSpy.mockRestore();
  });

  it('passes window tool arguments through streamable HTTP transport', async () => {
    const resizeSpy = vi.fn<(width: number, height: number) => ReturnType<WindowMcpController['resize']>>(
      (width, height) => ({
        bounds: { x: 0, y: 0, width, height },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
    );

    const windowController: WindowMcpController = {
      getInfo: () => ({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
      resize: resizeSpy,
      setDevTools: () => ({ devToolsOpen: false }),
      captureScreenshotPng: async () => Buffer.from([1, 2, 3]),
    };

    const server = await startShellDesktopMcpServer({ port: 0, window: windowController });
    servers.push(server);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(server.url);
    await client.connect(transport);

    const rawResult = await client.callTool(
      {
        name: 'window.resize',
        arguments: { width: 640, height: 480 },
      },
      CallToolResultSchema,
    );
    const result = CallToolResultSchema.parse(rawResult);
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });

    const firstContent = result.content[0];
    if (firstContent?.type !== 'text') {
      throw new Error('Expected text tool response');
    }

    const payload = JSON.parse(firstContent.text) as {
      ok: boolean;
      info: { bounds: { width: number; height: number } };
    };

    expect(payload).toMatchObject({
      ok: true,
      info: { bounds: { width: 640, height: 480 } },
    });
    expect(resizeSpy).toHaveBeenCalledWith(640, 480);

    await client.close();
  });

  it('accepts streamable HTTP requests on /mcp alias path', async () => {
    const server = await startShellDesktopMcpServer({ port: 0 });
    servers.push(server);

    const aliasUrl = new URL('/mcp', server.url);
    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(aliasUrl);
    await client.connect(transport);

    const rawResult = await client.callTool({ name: 'health', arguments: {} }, CallToolResultSchema);
    const result = CallToolResultSchema.parse(rawResult);
    expect(result.content[0]).toMatchObject({ type: 'text' });

    await client.close();
  });
});
