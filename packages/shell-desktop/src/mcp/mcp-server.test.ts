import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startShellDesktopMcpServer } from './mcp-server.js';

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

async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 750, pollMs = 10 }: Readonly<{ timeoutMs?: number; pollMs?: number }> = {},
): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  throw new Error('Timed out waiting for condition');
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
    const transport = new SSEClientTransport(server.sseUrl);
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
      const port = Number.parseInt(server.sseUrl.port, 10);
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

    const handlePostMessageSpy = vi
      .spyOn(SSEServerTransport.prototype, 'handlePostMessage')
      .mockImplementation(async (_request, response) => {
        response.writeHead(500).end('boom');
        throw new Error('boom');
      });

    try {
      const server = await startShellDesktopMcpServer({ port: 0 });
      servers.push(server);

      const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
      const transport = new SSEClientTransport(server.sseUrl);
      await client.connect(transport).catch(() => undefined);
      await client.close().catch(() => undefined);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      handlePostMessageSpy.mockRestore();
    }
  });

  it('closes per-session resources when SSE disconnects', async () => {
    const serverCloseSpy = vi.spyOn(McpServer.prototype, 'close');
    const transportCloseSpy = vi.spyOn(SSEServerTransport.prototype, 'close');

    const server = await startShellDesktopMcpServer({ port: 0 });
    servers.push(server);

    const client = new Client({ name: 'shell-desktop-test-client', version: '1.0.0' });
    const transport = new SSEClientTransport(server.sseUrl);
    await client.connect(transport);
    await client.close();

    await waitForCondition(() => serverCloseSpy.mock.calls.length > 0 && transportCloseSpy.mock.calls.length > 0);

    expect(serverCloseSpy).toHaveBeenCalled();
    expect(transportCloseSpy).toHaveBeenCalled();

    serverCloseSpy.mockRestore();
    transportCloseSpy.mockRestore();
  });
});
