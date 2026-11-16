// Specs for multiple `upstream.targets` and `balance` (not implemented yet;
// today every route uses its first target).

import { describe, it } from "node:test";

describe("load balancing", () => {
  it.todo("round_robin cycles through targets in config order");
  it.todo("weighted_round_robin sends 3:1 traffic for weights 3 and 1");
  it.todo("weighted_round_robin interleaves targets instead of sending bursts");
  it.todo("targets without a weight count as weight 1");
  it.todo("a single `url` upstream always uses that target");
  it.todo("each route keeps its own rotation");
  it.todo("skips targets marked unhealthy by health checks");
  it.todo("returns 503 when every target is unhealthy");
  it.todo("decide: a failed attempt (502) moves on to the next target or not");
});
