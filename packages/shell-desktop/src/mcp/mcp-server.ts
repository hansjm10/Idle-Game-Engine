import http from 'node:http';
import type { ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAssetTools } from './asset-tools.js';
import type { AssetMcpController } from './asset-tools.js';
import { registerInputTools } from './input-tools.js';
import type { InputMcpController } from './input-tools.js';
import { registerSimTools } from './sim-tools.js';
import type { SimMcpController } from './sim-tools.js';
import { registerWindowTools } from './window-tools.js';
import type { WindowMcpController } from './window-tools.js';

export type ShellDesktopMcpServer = Readonly<{
  url: URL;
  close: () => Promise<void>;
}>;

type ShellDesktopMcpServerOptions = Readonly<{
  port?: number;
  sim?: SimMcpController;
  window?: WindowMcpController;
  input?: InputMcpController;
  asset?: AssetMcpController;
}>;

const MCP_SERVER_INFO = {
  name: 'idle-engine-shell-desktop',
  version: '0.1.0',
} as const;

const DEFAULT_MCP_PORT = 8570;
const MCP_HOST = '127.0.0.1';

const MCP_HTTP_PATH = '/mcp/sse';

export function isShellDesktopMcpServerEnabled(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.IDLE_ENGINE_ENABLE_MCP_SERVER === '1' || argv.includes('--enable-mcp-server');
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new TypeError(`Invalid MCP port: ${value}`);
  }
  return parsed;
}

function getRequestedPort(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const envPort = env.IDLE_ENGINE_MCP_PORT;
  if (envPort !== undefined) {
    return parsePort(envPort);
  }

  for (const arg of argv) {
    if (arg.startsWith('--mcp-port=')) {
      return parsePort(arg.slice('--mcp-port='.length));
    }
  }

  return DEFAULT_MCP_PORT;
}

function createShellDesktopMcpServer(
  options: Readonly<{
    sim?: SimMcpController;
    window?: WindowMcpController;
    input?: InputMcpController;
    asset?: AssetMcpController;
  }>,
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);

  server.registerTool(
    'health',
    {
      title: 'Health',
      description: 'Returns a basic health/capabilities snapshot for the embedded shell-desktop MCP server.',
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, server: MCP_SERVER_INFO }),
        },
      ],
    }),
  );

  if (options.sim) {
    registerSimTools(server, options.sim);
  }

  if (options.window) {
    registerWindowTools(server, options.window);
  }

  if (options.input) {
    registerInputTools(server, options.input);
  }

  if (options.asset) {
    registerAssetTools(server, options.asset);
  }

  return server;
}

export async function startShellDesktopMcpServer(
  options: ShellDesktopMcpServerOptions = {},
): Promise<ShellDesktopMcpServer> {
  const port = options.port ?? DEFAULT_MCP_PORT;

  const server = createShellDesktopMcpServer({
    sim: options.sim,
    window: options.window,
    input: options.input,
    asset: options.asset,
  });
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport);

  const safeEndResponse = (res: ServerResponse, statusCode: number, message: string): void => {
    if (res.writableEnded) {
      return;
    }

    if (!res.headersSent) {
      res.writeHead(statusCode);
    }

    res.end(message);
  };

  const httpServer = http.createServer((req, res) => {
    const urlText = req.url;
    if (!urlText) {
      safeEndResponse(res, 400, 'Missing request URL.');
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(urlText, 'http://localhost');
    } catch {
      safeEndResponse(res, 400, 'Invalid request URL.');
      return;
    }

    if (requestUrl.pathname === MCP_HTTP_PATH) {
      transport.handleRequest(req, res).catch((error: unknown) => {
        safeEndResponse(res, 500, String(error));
      });
      return;
    }

    safeEndResponse(res, 404, 'Not found.');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen({ host: MCP_HOST, port }, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve MCP server address.');
  }

  const baseUrl = new URL(`http://${MCP_HOST}:${address.port}`);
  const url = new URL(MCP_HTTP_PATH, baseUrl);

  const close = async (): Promise<void> => {
    await Promise.allSettled([server.close(), transport.close()]);

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return { url, close };
}

export async function maybeStartShellDesktopMcpServer(
  options: Readonly<{
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    sim?: SimMcpController;
    window?: WindowMcpController;
    input?: InputMcpController;
    asset?: AssetMcpController;
  }> = {},
): Promise<ShellDesktopMcpServer | undefined> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;

  if (!isShellDesktopMcpServerEnabled(argv, env)) {
    return undefined;
  }

  const port = getRequestedPort(argv, env);
  const server = await startShellDesktopMcpServer({
    port,
    sim: options.sim,
    window: options.window,
    input: options.input,
    asset: options.asset,
  });

  if (env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.log(`[shell-desktop] MCP server listening at ${server.url.toString()}`);
  }

  return server;
}
