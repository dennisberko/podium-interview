// Entrypoint: resolve the config path, load + validate config (fail fast),
// start listening, and shut down gracefully on SIGINT/SIGTERM.
//
// Config path precedence:
//   1. positional arg or --config / -c   (npm start -- path/to/gateway.yaml)
//   2. GATEWAY_CONFIG environment variable
//   3. ./gateway.yaml

import type { Server } from "node:http";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { createGateway } from "./gateway.ts";

const CONFIG_ENV_VAR = "GATEWAY_CONFIG";
const SHUTDOWN_GRACE_MS = 10_000;

function configPathFromArgs(argv: string[]): string | undefined {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { config: { type: "string", short: "c" } },
    allowPositionals: true,
  });
  return values.config ?? positionals[0];
}

function resolveConfigPath(): string {
  return (
    configPathFromArgs(process.argv.slice(2)) ??
    process.env[CONFIG_ENV_VAR] ??
    DEFAULT_CONFIG_PATH
  );
}

/** Stop accepting connections, let in-flight requests finish, then exit. */
function installShutdown(server: Server): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.error(`${signal} received again, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      console.error("graceful shutdown timed out, closing connections");
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function main(): void {
  const configPath = resolveConfigPath();
  let config: ReturnType<typeof loadConfig> | undefined = undefined;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const server = createGateway(config);
  server.on("error", (err) => {
    console.error(`gateway failed to listen on port ${config.port}:`, err);
    process.exit(1);
  });
  server.listen(config.port, () => {
    console.log(
      `GatewayKit listening on :${config.port} (${config.routes.length} routes from ${configPath})`,
    );
  });
  installShutdown(server);
}

main();
