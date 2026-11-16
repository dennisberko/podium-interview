// Active health checks for a route's upstream targets (`health_check`).
//
// While the gateway is listening, every target gets `GET <target base><path>`
// right away and then again `interval` after each round finishes.
//   - A 2xx answer passes. Any other status, a connection error, or no answer
//     within min(route timeout, interval) fails.
//   - `unhealthy_threshold` failures in a row mark the target unhealthy; a
//     pass resets the count.
//   - One pass marks an unhealthy target healthy again.
//   - Targets start healthy, so traffic flows before the first round ends.
// Only these probes decide health; failures of real requests don't count.
//
// Health is per route: two routes sharing a target keep separate state.
// Routes without `health_check` treat every target as always healthy.

import type { Every } from "../clock.ts";
import type { RouteConfig } from "../config.ts";
import type { TargetHealth } from "../load-balancing/balancer.ts";
import type { UpstreamRequest } from "../pipeline/context.ts";
import { callUpstream } from "../upstream/client.ts";
import { upstreamUrl } from "../upstream/url.ts";

export interface HealthChecker extends TargetHealth {
  /** Start probing. Called once the gateway is listening. */
  start: () => void;
  /** Stop probing and abort probes in flight. Called when the gateway closes. */
  stop: () => void;
}

interface TargetState {
  url: URL;
  healthy: boolean;
  /** Consecutive failed probes. */
  failures: number;
}

const ALWAYS_HEALTHY: HealthChecker = {
  isHealthy: () => true,
  start: () => undefined,
  stop: () => undefined,
};

export function createHealthChecker(
  route: RouteConfig,
  every: Every,
): HealthChecker {
  const config = route.health_check;
  if (!config) {
    return ALWAYS_HEALTHY;
  }
  const { interval, unhealthy_threshold: threshold } = config;
  const timeoutMs = Math.min(route.timeout_ms, interval);
  const probe: UpstreamRequest = {
    method: "GET",
    path: config.path,
    search: "",
    headers: {},
    body: { kind: "buffered", data: Buffer.alloc(0) },
  };
  const states: TargetState[] = route.upstream.targets.map((target) => ({
    url: upstreamUrl(new URL(target.url), probe),
    healthy: true,
    failures: 0,
  }));
  let running: { cancel: () => void; controller: AbortController } | undefined =
    undefined;

  async function passes(url: URL, signal: AbortSignal): Promise<boolean> {
    try {
      const res = await callUpstream({
        url,
        request: probe,
        timeoutMs,
        signal,
      });
      // Only the status matters; drain the body so the socket can be reused.
      if (res.body.kind === "stream") {
        res.body.stream.resume();
      }
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  function record(state: TargetState, passed: boolean): void {
    if (passed) {
      state.failures = 0;
      if (!state.healthy) {
        state.healthy = true;
        console.log(`route ${route.path}: ${state.url.href} is healthy again`);
      }
      return;
    }
    state.failures += 1;
    if (state.healthy && state.failures >= threshold) {
      state.healthy = false;
      console.warn(
        `route ${route.path}: ${state.url.href} marked unhealthy after ${state.failures} failed checks`,
      );
    }
  }

  async function round(signal: AbortSignal): Promise<void> {
    await Promise.all(
      states.map(async (state) => {
        const passed = await passes(state.url, signal);
        // A probe aborted by `stop` says nothing about the target.
        if (!signal.aborted) {
          record(state, passed);
        }
      }),
    );
  }

  return {
    isHealthy: (index) => states[index]?.healthy ?? false,
    start: () => {
      if (running) {
        return;
      }
      const controller = new AbortController();
      const cancel = every(interval, async () => round(controller.signal));
      running = { cancel, controller };
    },
    stop: () => {
      running?.cancel();
      running?.controller.abort();
      running = undefined;
    },
  };
}
