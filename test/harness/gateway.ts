// Starts a real gateway (createGateway) on an ephemeral port from YAML text,
// so every test also goes through config validation and default resolution.
// `gateway.port` in the YAML is ignored; the test gateway always uses port 0.

import type { TestContext } from "node:test";
import { parseConfig } from "../../src/config.ts";
import type { GatewayOptions } from "../../src/gateway.ts";
import { createGateway } from "../../src/gateway.ts";
import { closeServer, listen } from "./server.ts";

/** Prepended when the test's YAML has no top-level `gateway:` section. */
const DEFAULT_GATEWAY_SECTION = `gateway:
  port: 8080
  global_timeout: "30s"
`;

export interface TestGateway {
  /** Base URL, e.g. "http://127.0.0.1:54321". */
  url: string;
  /** Close it before the test ends (it is closed automatically otherwise). */
  close: () => Promise<void>;
}

export async function startGateway(
  t: TestContext,
  configYaml: string,
  options: GatewayOptions = {},
): Promise<TestGateway> {
  const text = /^gateway:/m.test(configYaml)
    ? configYaml
    : `${DEFAULT_GATEWAY_SECTION}${configYaml}`;
  const server = createGateway(parseConfig(text), options);
  const url = await listen(server);
  let closed: Promise<void> | undefined = undefined;
  const close = async (): Promise<void> => {
    closed ??= closeServer(server);
    return closed;
  };
  t.after(close);
  return { url, close };
}
