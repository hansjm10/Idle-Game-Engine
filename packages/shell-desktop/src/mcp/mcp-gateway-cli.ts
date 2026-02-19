import {
  getRequestedShellDesktopMcpGatewayPort,
  getRequestedShellDesktopMcpGatewayTargetUrl,
  startShellDesktopMcpGateway,
} from './mcp-gateway.js';

async function main(): Promise<void> {
  const port = getRequestedShellDesktopMcpGatewayPort(process.env);
  const targetUrl = getRequestedShellDesktopMcpGatewayTargetUrl(process.env);

  const gateway = await startShellDesktopMcpGateway({
    port,
    targetUrl,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[shell-desktop] MCP gateway listening at ${gateway.url.toString()} (backend: ${targetUrl.toString()})`,
  );

  const closeGateway = async (): Promise<void> => {
    await gateway.close().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  process.once('SIGINT', () => {
    void closeGateway().finally(() => {
      process.exit(130);
    });
  });

  process.once('SIGTERM', () => {
    void closeGateway().finally(() => {
      process.exit(143);
    });
  });

  await new Promise<void>(() => undefined);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
