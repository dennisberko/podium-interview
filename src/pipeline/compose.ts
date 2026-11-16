import type { Handler, Middleware } from "./context.ts";

/**
 * Chain middleware around a terminal handler. The first middleware is the
 * outermost: `compose([a, b], h)` runs a -> b -> h, and responses flow back
 * h -> b -> a.
 */
export function compose(
  middleware: readonly Middleware[],
  terminal: Handler,
): Handler {
  return middleware.reduceRight<Handler>(
    (next, stage) => async (ctx) => stage(ctx, async () => next(ctx)),
    terminal,
  );
}
