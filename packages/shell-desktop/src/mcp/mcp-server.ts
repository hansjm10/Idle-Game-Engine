import http from 'node:http';
import type { ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAssetTools } from './asset-tools.js';
import type { AssetMcpController } from './asset-tools.js';
import { registerDiagnosticsTools } from './diagnostics-tools.js';
import type { DiagnosticsMcpController } from './diagnostics-tools.js';
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
  diagnostics?: DiagnosticsMcpController;
}>;

const MCP_SERVER_INFO = {
  name: 'idle-engine-shell-desktop',
  version: '0.1.0',
} as const;

const DEFAULT_MCP_PORT = 8570;
const MCP_HOST = '127.0.0.1';

const MCP_HTTP_PATH = '/mcp/sse';
const MCP_HTTP_PATH_ALIAS = '/mcp';

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

function getRequestedPort(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Readonly<{ port: number; explicit: boolean }> {
  const envPort = env.IDLE_ENGINE_MCP_PORT;
  if (envPort !== undefined) {
    return { port: parsePort(envPort), explicit: true };
  }

  for (const arg of argv) {
    if (arg.startsWith('--mcp-port=')) {
      return { port: parsePort(arg.slice('--mcp-port='.length)), explicit: true };
    }
  }

  return { port: DEFAULT_MCP_PORT, explicit: false };
}

function createShellDesktopMcpServer(
  options: Readonly<{
    sim?: SimMcpController;
    window?: WindowMcpController;
    input?: InputMcpController;
    asset?: AssetMcpController;
    diagnostics?: DiagnosticsMcpController;
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

  if (options.diagnostics) {
    registerDiagnosticsTools(server, options.diagnostics);
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
    diagnostics: options.diagnostics,
  });
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

  const safeEndResponse = (res: ServerResponse, statusCode: number, message: string): void => {
    if (res.writableEnded) {
      return;
    }

    if (!res.headersSent) {
      res.writeHead(statusCode);
    }

    res.end(message);
  };

  const setAcceptHeader = (req: http.IncomingMessage, value: string): void => {
    req.headers.accept = value;

    if (Array.isArray(req.rawHeaders)) {
      let updated = false;
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index]?.toLowerCase() !== 'accept') {
          continue;
        }
        req.rawHeaders[index + 1] = value;
        updated = true;
      }

      if (!updated) {
        req.rawHeaders.push('accept', value);
      }
    }
  };

  const ensureCompatibleAcceptHeader = (req: http.IncomingMessage): void => {
    if (req.method !== 'POST') {
      return;
    }

    const rawAccept = req.headers.accept;
    const accept = Array.isArray(rawAccept) ? rawAccept.join(', ') : rawAccept ?? '';
    const normalizedAccept = accept.toLowerCase();

    const hasJson = normalizedAccept.includes('application/json');
    const hasSse = normalizedAccept.includes('text/event-stream');
    if (hasJson && hasSse) {
      return;
    }

    const nextAcceptValues = [accept.trim()].filter((value) => value.length > 0);
    if (!hasJson) {
      nextAcceptValues.push('application/json');
    }
    if (!hasSse) {
      nextAcceptValues.push('text/event-stream');
    }
    setAcceptHeader(req, nextAcceptValues.join(', '));
  };

  const closeHttpServer = async (httpServer: http.Server): Promise<void> => {
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
  const closeServerResources = async (): Promise<void> => {
    await Promise.allSettled([server.close(), transport.close()]);
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

    if (requestUrl.pathname === MCP_HTTP_PATH || requestUrl.pathname === MCP_HTTP_PATH_ALIAS) {
      ensureCompatibleAcceptHeader(req);
      transport.handleRequest(req, res).catch((error: unknown) => {
        safeEndResponse(res, 500, String(error));
      });
      return;
    }

    safeEndResponse(res, 404, 'Not found.');
  });

  try {
    await server.connect(transport);

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
      await closeServerResources();
      await closeHttpServer(httpServer);
    };

    return { url, close };
  } catch (error: unknown) {
    await closeServerResources();

    if (httpServer.listening) {
      await closeHttpServer(httpServer);
    }

    throw error;
  }
}

export async function maybeStartShellDesktopMcpServer(
  options: Readonly<{
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    sim?: SimMcpController;
    window?: WindowMcpController;
    input?: InputMcpController;
    asset?: AssetMcpController;
    diagnostics?: DiagnosticsMcpController;
  }> = {},
): Promise<ShellDesktopMcpServer | undefined> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;

  if (!isShellDesktopMcpServerEnabled(argv, env)) {
    return undefined;
  }

  const requested = getRequestedPort(argv, env);
  const isPortBusyError = (error: unknown): boolean =>
    error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

  let selectedPort = requested.port;
  let server: ShellDesktopMcpServer | undefined;
  try {
    server = await startShellDesktopMcpServer({
      port: requested.port,
      sim: options.sim,
      window: options.window,
      input: options.input,
      asset: options.asset,
      diagnostics: options.diagnostics,
    });
  } catch (error: unknown) {
    if (requested.explicit || !isPortBusyError(error) || requested.port >= 65535) {
      throw error;
    }

    let fallbackError: unknown = error;
    for (let fallbackPort = requested.port + 1; fallbackPort <= 65535; fallbackPort += 1) {
      try {
        server = await startShellDesktopMcpServer({
          port: fallbackPort,
          sim: options.sim,
          window: options.window,
          input: options.input,
          asset: options.asset,
          diagnostics: options.diagnostics,
        });
        selectedPort = fallbackPort;
        fallbackError = undefined;
        break;
      } catch (nextError: unknown) {
        fallbackError = nextError;
        if (!isPortBusyError(nextError) || fallbackPort === 65535) {
          throw nextError;
        }
      }
    }

    if (!server) {
      throw fallbackError;
    }

    if (env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn(
        `[shell-desktop] MCP port ${requested.port} is busy; using ${selectedPort} instead.`,
      );
    }
  }

  if (env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.log(`[shell-desktop] MCP server listening at ${server.url.toString()}`);
  }

  if (!server) {
    throw new Error('Failed to start MCP server.');
  }

  return server;
}
