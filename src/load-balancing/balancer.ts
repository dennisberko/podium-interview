// Picks the upstream target for each try of a request.
//
// One algorithm serves both `balance` modes: smooth weighted round robin (the
// one nginx uses). Config validation keeps every weight at 1 under
// `round_robin`, and with equal weights it simply cycles in config order.
//
// Each pick, every healthy target's `current` grows by its weight, the
// largest `current` wins (ties go to the earlier target), and the winner's
// `current` drops by the total healthy weight. Weights 3:1 give A A B A, so
// heavy targets get their share spread out rather than in bursts.
//
// Unhealthy targets are left out of the round, so traffic is shared among
// the rest in proportion to their weights. State is per route, in memory.

import type { UpstreamConfig } from "../config.ts";

/** Whether a target (by index in `upstream.targets`) may receive traffic. */
export interface TargetHealth {
  isHealthy: (index: number) => boolean;
}

/** Index of the next target in `upstream.targets`, or `undefined` if none is healthy. */
export type PickTarget = () => number | undefined;

interface Slot {
  index: number;
  weight: number;
  current: number;
}

export function createBalancer(
  { targets }: UpstreamConfig,
  health: TargetHealth,
): PickTarget {
  const slots: Slot[] = targets.map(({ weight }, index) => ({
    index,
    weight,
    current: 0,
  }));

  return () => {
    let total = 0;
    let best: Slot | undefined = undefined;
    for (const slot of slots) {
      if (health.isHealthy(slot.index)) {
        slot.current += slot.weight;
        total += slot.weight;
        if (!best || slot.current > best.current) {
          best = slot;
        }
      }
    }
    if (!best) {
      return undefined;
    }
    best.current -= total;
    return best.index;
  };
}
