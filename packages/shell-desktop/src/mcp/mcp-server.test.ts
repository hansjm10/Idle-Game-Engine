import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
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

describe('shell-desktop MCP server', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  it('exposes the health tool over SSE', async () => {
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
        name: 'window/resize',
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
});
