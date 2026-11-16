// Specs for per-route upstream `health_check` (not implemented yet).
// Drive probe intervals with the injected clock.

import { describe, it } from "node:test";

describe("upstream health checks", () => {
  it.todo(
    "probes GET <target><health_check.path> on every target each `interval`",
  );
  it.todo(
    "marks a target unhealthy after `unhealthy_threshold` consecutive failures",
  );
  it.todo("a success resets the consecutive failure count");
  it.todo("an unhealthy target becomes healthy again after a successful probe");
  it.todo(
    "non-2xx responses, connection errors and timeouts count as failures",
  );
  it.todo("targets start healthy before the first probe");
  it.todo("stops probing when the gateway closes");
  it.todo("routes without health_check never probe");
});
