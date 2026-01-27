import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { AddressInfo } from 'node:net';

export type ShellDesktopMcpServer = Readonly<{
  sseUrl: URL;
  close: () => Promise<void>;
}>;

type ShellDesktopMcpServerOptions = Readonly<{
  port?: number;
}>;

const MCP_SERVER_INFO = {
  name: 'idle-engine-shell-desktop',
  version: '0.1.0',
} as const;

const DEFAULT_MCP_PORT = 8570;
const MCP_HOST = '127.0.0.1';

const MCP_SSE_PATH = '/mcp/sse';
const MCP_MESSAGE_PATH = '/mcp/message';

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

function createShellDesktopMcpServer(): McpServer {
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

  return server;
}

export async function startShellDesktopMcpServer(
  options: ShellDesktopMcpServerOptions = {},
): Promise<ShellDesktopMcpServer> {
  const port = options.port ?? DEFAULT_MCP_PORT;

  const sessions = new Map<string, Readonly<{ transport: SSEServerTransport; server: McpServer }>>();

  const httpServer = http.createServer((req, res) => {
    const urlText = req.url;
    if (!urlText) {
      res.writeHead(400).end('Missing request URL.');
      return;
    }

    const requestUrl = new URL(urlText, 'http://localhost');

    if (req.method === 'GET' && requestUrl.pathname === MCP_SSE_PATH) {
      const server = createShellDesktopMcpServer();
      const transport = new SSEServerTransport(MCP_MESSAGE_PATH, res);
      sessions.set(transport.sessionId, { transport, server });

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
      };

      void server.connect(transport).catch((error: unknown) => {
        sessions.delete(transport.sessionId);
        res.writeHead(500).end(String(error));
      });

      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === MCP_MESSAGE_PATH) {
      const sessionId = requestUrl.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400).end('Missing sessionId.');
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404).end('Unknown sessionId.');
        return;
      }

      void session.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end('Not found.');
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

  const baseUrl = new URL(`http://${MCP_HOST}:${(address as AddressInfo).port}`);
  const sseUrl = new URL(MCP_SSE_PATH, baseUrl);

  const close = async (): Promise<void> => {
    await Promise.allSettled(
      [...sessions.values()].map(async ({ server, transport }) => {
        await Promise.allSettled([server.close(), transport.close()]);
      }),
    );
    sessions.clear();

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

  return { sseUrl, close };
}

export async function maybeStartShellDesktopMcpServer(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellDesktopMcpServer | undefined> {
  if (!isShellDesktopMcpServerEnabled(argv, env)) {
    return undefined;
  }

  const port = getRequestedPort(argv, env);
  const server = await startShellDesktopMcpServer({ port });

  if (env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.log(`[shell-desktop] MCP server listening at ${server.sseUrl.toString()}`);
  }

  return server;
}

