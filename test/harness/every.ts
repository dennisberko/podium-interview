// A hand-driven `Every` for health-check tests: no timers. Like the real one,
// each task runs as soon as it is registered; after that it only runs when the
// test calls `tick()`.

import type { Every } from "../../src/clock.ts";

interface Task {
  ms: number;
  run: () => Promise<void>;
  live: boolean;
}

export interface ManualEvery {
  every: Every;
  /** Wait for runs in flight, run every live task once more, wait for those. */
  tick: () => Promise<void>;
  /** Wait for runs in flight (e.g. the first round after the gateway starts). */
  settled: () => Promise<void>;
  /** `ms` of each task still scheduled (not cancelled). */
  live: () => number[];
}

export function manualEvery(): ManualEvery {
  const tasks: Task[] = [];
  const inFlight = new Set<Promise<void>>();

  function launch(task: Task): void {
    const running = task.run().finally(() => inFlight.delete(running));
    inFlight.add(running);
  }

  async function settled(): Promise<void> {
    await Promise.all(inFlight);
  }

  return {
    every: (ms, run) => {
      const task: Task = { ms, run, live: true };
      tasks.push(task);
      launch(task);
      return () => {
        task.live = false;
      };
    },
    tick: async () => {
      await settled();
      for (const task of tasks) {
        if (task.live) {
          launch(task);
        }
      }
      await settled();
    },
    settled,
    live: () => tasks.filter(({ live }) => live).map(({ ms }) => ms),
  };
}
