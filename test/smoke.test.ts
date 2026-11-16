// End-to-end: runs the real entrypoint (src/main.ts) as a child process, so
// config path handling, startup validation and graceful shutdown are covered.

import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "./harness/server.ts";
import { startUpstream } from "./harness/upstream.ts";
import { yaml } from "./harness/yaml.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function writeConfig(t: TestContext, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gateway-smoke-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.yaml");
  await writeFile(path, contents);
  return path;
}

function startMain(
  t: TestContext,
  configPath: string,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/main.ts", "--config", configPath],
    { cwd: PROJECT_ROOT },
  );
  t.after(() => {
    child.kill("SIGKILL");
  });
  return child;
}

/** Resolves once the gateway logs that it is listening. */
async function listening(child: ChildProcessWithoutNullStreams): Promise<void> {
  for await (const [chunk] of on(child.stdout, "data")) {
    if (String(chunk).includes("listening")) {
      return;
    }
  }
}

describe("gateway process", () => {
  it("starts from a config file, serves traffic and shuts down on SIGTERM", async (t) => {
    const upstream = await startUpstream(t, (_req, res) => {
      res.end("hello from upstream");
    });
    const port = await freePort();
    const configPath = await writeConfig(
      t,
      yaml`
        gateway:
          port: ${port}
          global_timeout: "5s"
        routes:
          - path: /api
            methods: [GET]
            upstream: { url: "${upstream.url}" }
      `,
    );
    const child = startMain(t, configPath);
    await listening(child);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const proxied = await fetch(`http://127.0.0.1:${port}/api`);

    const healthBody = await health.json();
    assert.equal(healthBody.status, "healthy");
    assert.equal(await proxied.text(), "hello from upstream");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
  });

  it("exits 1 with the validation problems when the config is invalid", async (t) => {
    const configPath = await writeConfig(
      t,
      yaml`
        gateway:
          port: 8080
          global_timeout: "30 sec"
        routes: []
      `,
    );
    const child = startMain(t, configPath);

    const [stderr, [code]] = await Promise.all([
      text(child.stderr),
      once(child, "exit"),
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /Invalid gateway config/);
    assert.match(stderr, /gateway\.global_timeout: invalid duration "30 sec"/);
  });

  it("exits 1 when the config file is missing", async (t) => {
    const child = startMain(t, "/nonexistent/gateway.yaml");

    const [stderr, [code]] = await Promise.all([
      text(child.stderr),
      once(child, "exit"),
    ]);

    assert.equal(code, 1);
    assert.match(stderr, /cannot read \/nonexistent\/gateway\.yaml/);
  });
});
