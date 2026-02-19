import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromShellDesktop = createRequire(new URL('../../packages/shell-desktop/package.json', import.meta.url));

const clientModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/client/index.js');
const transportModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
const typesModulePath = requireFromShellDesktop.resolve('@modelcontextprotocol/sdk/types.js');

const { Client } = await import(pathToFileURL(clientModulePath).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(transportModulePath).href);
const { CallToolResultSchema } = await import(pathToFileURL(typesModulePath).href);

const port = process.env.IDLE_ENGINE_MCP_PORT ?? '8570';
const url = new URL(`http://127.0.0.1:${port}/mcp/sse`);

const client = new Client({
  name: 'shell-desktop-smoke',
  version: '1.0.0',
});

await client.connect(new StreamableHTTPClientTransport(url));
const tools = await client.listTools();
const rawHealth = await client.callTool({ name: 'health', arguments: {} }, CallToolResultSchema);
await client.close();

const firstContent = rawHealth.content?.[0];
const healthText = firstContent?.type === 'text' ? firstContent.text : '';

console.log(JSON.stringify({
  endpoint: url.toString(),
  toolCount: tools.tools.length,
  health: healthText,
}, null, 2));
