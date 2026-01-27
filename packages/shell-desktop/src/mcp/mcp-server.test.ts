import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startShellDesktopMcpServer } from './mcp-server.js';

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
});
