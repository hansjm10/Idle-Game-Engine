import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { URL } from 'node:url';

export type ShellDesktopMcpGateway = Readonly<{
  url: URL;
  close: () => Promise<void>;
}>;

export type ShellDesktopMcpGatewayOptions = Readonly<{
  host?: string;
  port?: number;
  targetUrl?: URL | string;
  proxyTimeoutMs?: number;
}>;

type JsonRpcRequest = Readonly<{
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}>;

type JsonRpcError = Readonly<{
  code: number;
  message: string;
}>;

type JsonRpcResultPayload = Readonly<{
  jsonrpc: '2.0';
  id: unknown;
  result: unknown;
}>;

type JsonRpcErrorPayload = Readonly<{
  jsonrpc: '2.0';
  id: unknown;
  error: JsonRpcError;
}>;

const MCP_HTTP_PATH = '/mcp/sse';
const MCP_HTTP_PATH_ALIAS = '/mcp';
const DEFAULT_GATEWAY_HOST = '127.0.0.1';
const DEFAULT_GATEWAY_PORT = 8570;
const DEFAULT_PROXY_TIMEOUT_MS = 5000;
const DEFAULT_BACKEND_URL = new URL('http://127.0.0.1:8571/mcp/sse');
const MAX_POST_BYTES = 5_000_000;

const GATEWAY_SERVER_INFO = {
  name: 'idle-engine-shell-desktop-gateway',
  version: '0.1.0',
} as const;

const FALLBACK_TOOLS = [
  {
    name: 'health',
    description: 'Reports gateway/backend availability for the shell-desktop MCP bridge.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.status',
    description: 'Returns the current simulation status (step, step size, lifecycle state).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.start',
    description: 'Starts the simulation tick loop if it is not running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.stop',
    description: 'Stops the simulation and disposes the worker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.pause',
    description: 'Pauses the simulation tick loop while keeping the worker alive.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.resume',
    description: 'Resumes the simulation tick loop after pausing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sim.step',
    description: 'Advances the simulation by N steps while paused.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  },
  {
    name: 'sim.enqueue',
    description: 'Enqueues runtime commands onto the simulation command queue deterministically.',
    inputSchema: {
      type: 'object',
      properties: { commands: { type: 'array' } },
      required: ['commands'],
      additionalProperties: false,
    },
  },
  {
    name: 'window.info',
    description: 'Returns basic information about the main window (bounds, url, devtools state).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'window.resize',
    description: 'Resizes the main window to the requested width/height.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
      },
      required: ['width', 'height'],
      additionalProperties: false,
    },
  },
  {
    name: 'window.devtools',
    description: 'Opens, closes, or toggles the main window devtools.',
    inputSchema: {
      type: 'object',
      properties: { action: { enum: ['open', 'close', 'toggle'] } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'window.screenshot',
    description: 'Captures a PNG screenshot of the main window web contents (bounded).',
    inputSchema: {
      type: 'object',
      properties: { maxBytes: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  },
  {
    name: 'input.controlEvent',
    description: 'Injects a shell control event into the active simulation control scheme.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        phase: { enum: ['start', 'repeat', 'end'] },
        value: { type: 'number' },
        metadata: { type: 'object' },
      },
      required: ['intent', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'asset.list',
    description: 'Lists compiled assets under the configured assets root directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        maxEntries: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asset.read',
    description: 'Reads a compiled asset file from the configured assets root directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        maxBytes: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
] as const;

function safeEndResponse(res: ServerResponse, statusCode: number, body: string): void {
  if (res.writableEnded) {
    return;
  }

  if (!res.headersSent) {
    res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  }

  res.end(body);
}

function writeJsonResponse(res: ServerResponse, statusCode: number, payload: JsonRpcResultPayload | JsonRpcErrorPayload): void {
  if (res.writableEnded) {
    return;
  }

  const body = JSON.stringify(payload);
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
  }

  res.end(body);
}

function writeJsonRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  writeJsonResponse(res, 200, { jsonrpc: '2.0', id, result });
}

function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  id: unknown,
  code: number,
  message: string,
): void {
  writeJsonResponse(res, statusCode, { jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new TypeError(`Invalid MCP gateway port: ${value}`);
  }
  return parsed;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
}

function normalizeTargetUrl(targetUrl: URL | string | undefined): URL {
  const resolved = targetUrl === undefined
    ? new URL(DEFAULT_BACKEND_URL.toString())
    : new URL(targetUrl.toString());

  if (resolved.protocol !== 'http:') {
    throw new TypeError(`Unsupported MCP backend protocol: ${resolved.protocol}. Expected http:`);
  }

  if (!isLoopbackHostname(resolved.hostname)) {
    throw new TypeError(`Invalid MCP backend host: ${resolved.hostname}. Expected a loopback host.`);
  }

  if (resolved.pathname.length === 0 || resolved.pathname === '/') {
    resolved.pathname = MCP_HTTP_PATH;
  }

  return resolved;
}

function buildForwardHeaders(headers: IncomingHttpHeaders, requestBody: Buffer | undefined, targetUrl: URL): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      lowerName === 'host' ||
      lowerName === 'connection' ||
      lowerName === 'content-length' ||
      lowerName === 'transfer-encoding' ||
      lowerName === 'keep-alive' ||
      lowerName === 'proxy-connection' ||
      lowerName === 'upgrade'
    ) {
      continue;
    }

    forwarded[name] = value;
  }

  forwarded.host = targetUrl.host;
  if (requestBody !== undefined) {
    forwarded['content-length'] = String(requestBody.byteLength);
  }

  return forwarded;
}

async function readRequestBody(req: http.IncomingMessage, maxBytes = MAX_POST_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += bufferChunk.byteLength;
    if (bytes > maxBytes) {
      throw new Error(`Request body exceeds max size (${bytes} > ${maxBytes}).`);
    }
    chunks.push(bufferChunk);
  }

  return Buffer.concat(chunks);
}

async function tryProxyRequest(
  req: http.IncomingMessage,
  res: ServerResponse,
  options: Readonly<{
    requestBody?: Buffer;
    requestSearch: string;
    targetUrl: URL;
    timeoutMs: number;
  }>,
): Promise<boolean> {
  const targetPath = `${options.targetUrl.pathname}${options.requestSearch}`;
  const requestMethod = req.method ?? 'GET';

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const upstreamRequest = http.request(
      {
        protocol: options.targetUrl.protocol,
        hostname: options.targetUrl.hostname,
        port: options.targetUrl.port,
        method: requestMethod,
        path: targetPath,
        headers: buildForwardHeaders(req.headers, options.requestBody, options.targetUrl),
      },
      (upstreamResponse) => {
        if (!res.headersSent) {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        }

        upstreamResponse.pipe(res);
        settle(true);
      },
    );

    upstreamRequest.setTimeout(options.timeoutMs, () => {
      upstreamRequest.destroy(new Error('MCP backend request timed out.'));
    });

    upstreamRequest.on('error', () => {
      settle(false);
    });

    if (options.requestBody !== undefined) {
      upstreamRequest.end(options.requestBody);
      return;
    }

    req.pipe(upstreamRequest);
  });
}

function getRequestId(payload: JsonRpcRequest): unknown {
  return payload.id === undefined ? null : payload.id;
}

function buildFallbackHealthResult(targetUrl: URL): Readonly<{
  ok: boolean;
  ready: boolean;
  backendReachable: boolean;
  backendUrl: string;
  server: typeof GATEWAY_SERVER_INFO;
}> {
  return {
    ok: false,
    ready: false,
    backendReachable: false,
    backendUrl: targetUrl.toString(),
    server: GATEWAY_SERVER_INFO,
  };
}

function handleUnavailableToolCall(
  res: ServerResponse,
  id: unknown,
  params: unknown,
  targetUrl: URL,
): void {
  if (!isRecord(params) || typeof params.name !== 'string') {
    writeJsonRpcError(res, 400, id, -32602, 'Invalid params: expected { name: string }');
    return;
  }

  if (params.name === 'health') {
    writeJsonRpcResult(res, id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(buildFallbackHealthResult(targetUrl)),
        },
      ],
    });
    return;
  }

  writeJsonRpcResult(res, id, {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: 'shell-desktop MCP backend is unavailable; start shell-desktop to enable this tool.',
          backendUrl: targetUrl.toString(),
        }),
      },
    ],
  });
}

function handleUnavailablePostRequest(
  res: ServerResponse,
  requestBody: Buffer,
  targetUrl: URL,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString('utf8'));
  } catch {
    writeJsonRpcError(res, 400, null, -32700, 'Parse error: Invalid JSON');
    return;
  }

  if (Array.isArray(parsed)) {
    writeJsonRpcError(res, 400, null, -32600, 'Invalid Request: batch payloads are not supported by fallback mode.');
    return;
  }

  if (!isRecord(parsed)) {
    writeJsonRpcError(res, 400, null, -32600, 'Invalid Request: expected a JSON-RPC request object.');
    return;
  }

  const request = parsed as JsonRpcRequest;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    writeJsonRpcError(res, 400, getRequestId(request), -32600, 'Invalid Request: expected jsonrpc="2.0" and method.');
    return;
  }

  const id = getRequestId(request);

  if (request.method === 'initialize') {
    const protocolVersion = isRecord(request.params) && typeof request.params.protocolVersion === 'string'
      ? request.params.protocolVersion
      : '2025-06-18';

    writeJsonRpcResult(res, id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      serverInfo: GATEWAY_SERVER_INFO,
    });
    return;
  }

  if (request.method === 'notifications/initialized' && id === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (request.method === 'tools/list') {
    writeJsonRpcResult(res, id, { tools: FALLBACK_TOOLS });
    return;
  }

  if (request.method === 'tools/call') {
    handleUnavailableToolCall(res, id, request.params, targetUrl);
    return;
  }

  if (id === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  writeJsonRpcError(res, 503, id, -32000, 'shell-desktop MCP backend is unavailable.');
}

async function handleGatewayRequest(
  req: http.IncomingMessage,
  res: ServerResponse,
  options: Readonly<{
    targetUrl: URL;
    proxyTimeoutMs: number;
  }>,
): Promise<void> {
  const rawUrl = req.url;
  if (!rawUrl) {
    safeEndResponse(res, 400, 'Missing request URL.');
    return;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(rawUrl, 'http://localhost');
  } catch {
    safeEndResponse(res, 400, 'Invalid request URL.');
    return;
  }

  if (requestUrl.pathname !== MCP_HTTP_PATH && requestUrl.pathname !== MCP_HTTP_PATH_ALIAS) {
    safeEndResponse(res, 404, 'Not found.');
    return;
  }

  if (req.method === 'POST') {
    let requestBody: Buffer;
    try {
      requestBody = await readRequestBody(req);
    } catch (error: unknown) {
      safeEndResponse(res, 413, error instanceof Error ? error.message : String(error));
      return;
    }

    const proxied = await tryProxyRequest(req, res, {
      requestBody,
      requestSearch: requestUrl.search,
      targetUrl: options.targetUrl,
      timeoutMs: options.proxyTimeoutMs,
    });

    if (!proxied) {
      handleUnavailablePostRequest(res, requestBody, options.targetUrl);
    }
    return;
  }

  const proxied = await tryProxyRequest(req, res, {
    requestSearch: requestUrl.search,
    targetUrl: options.targetUrl,
    timeoutMs: options.proxyTimeoutMs,
  });

  if (!proxied) {
    safeEndResponse(res, 503, 'shell-desktop MCP backend is unavailable.');
  }
}

export async function startShellDesktopMcpGateway(
  options: ShellDesktopMcpGatewayOptions = {},
): Promise<ShellDesktopMcpGateway> {
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const targetUrl = normalizeTargetUrl(options.targetUrl);
  const proxyTimeoutMs = options.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  const httpServer = http.createServer((req, res) => {
    void handleGatewayRequest(req, res, { targetUrl, proxyTimeoutMs }).catch((error: unknown) => {
      safeEndResponse(res, 500, String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen({ host, port }, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve MCP gateway address.');
  }

  const url = new URL(`http://${host}:${address.port}${MCP_HTTP_PATH}`);

  const close = async (): Promise<void> => {
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

export function getRequestedShellDesktopMcpGatewayPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envPort = env.IDLE_ENGINE_MCP_PORT;
  if (envPort !== undefined) {
    return parsePort(envPort);
  }
  return DEFAULT_GATEWAY_PORT;
}

export function getRequestedShellDesktopMcpGatewayTargetUrl(
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const explicitTarget = env.IDLE_ENGINE_MCP_BACKEND_URL;
  if (explicitTarget) {
    return normalizeTargetUrl(explicitTarget);
  }

  const backendPort = env.IDLE_ENGINE_MCP_BACKEND_PORT;
  if (backendPort !== undefined) {
    return normalizeTargetUrl(`http://${DEFAULT_GATEWAY_HOST}:${parsePort(backendPort)}${MCP_HTTP_PATH}`);
  }

  return normalizeTargetUrl(DEFAULT_BACKEND_URL);
}
