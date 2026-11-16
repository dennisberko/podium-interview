// Pipeline stage for `retry`.
//
// `attempts` counts every try, the first one included. A try is retried when:
//   - the upstream answers a status listed in `on`, or
//   - the upstream can't be reached (counts as 502) or times out (counts as
//     504), and that status is listed in `on`.
// Responses the gateway made itself (e.g. an open circuit breaker's 503) are
// never retried, and neither is a client disconnect. Every method is retried,
// POST included.
//
// Between tries it waits `initial_delay` (fixed), or `initial_delay` doubled
// after each try (exponential: 1s, 2s, 4s, ...). No jitter, and `Retry-After`
// from the upstream is ignored. The route timeout applies to each try on its
// own. When every try fails, the client gets the last upstream response as-is
// (or the usual 502/504 if the last try got no response).
//
// To replay it, the request body is read into memory first, up to
// MAX_BODY_BYTES; bigger bodies get 413 { "error": "payload_too_large" }.

import type { RouteConfig } from "../config.ts";
import { errorResponse } from "../http.ts";
import { bufferBody } from "../pipeline/buffer-body.ts";
import type {
  GatewayResponse,
  Middleware,
  RequestContext,
  StageDeps,
} from "../pipeline/context.ts";
import { UnreachableCaseError } from "../unreachable.ts";
import { UpstreamError } from "../upstream/client.ts";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;

type RetryConfig = NonNullable<RouteConfig["retry"]>;

type Outcome =
  | { kind: "response"; response: GatewayResponse }
  | { kind: "error"; error: unknown };

async function attempt(next: () => Promise<GatewayResponse>): Promise<Outcome> {
  try {
    return { kind: "response", response: await next() };
  } catch (error) {
    return { kind: "error", error };
  }
}

function unwrap(outcome: Outcome): GatewayResponse {
  if (outcome.kind === "error") {
    throw outcome.error;
  }
  return outcome.response;
}

/** The status a try counts as for `on`, or `undefined` if it is never retried. */
function retryableStatus(outcome: Outcome): number | undefined {
  if (outcome.kind === "response") {
    return outcome.response.source === "upstream"
      ? outcome.response.status
      : undefined;
  }
  if (!(outcome.error instanceof UpstreamError)) {
    return undefined;
  }
  switch (outcome.error.kind) {
    case "connection": {
      return 502;
    }
    case "timeout": {
      return 504;
    }
    case "aborted": {
      return undefined;
    }
    default: {
      throw new UnreachableCaseError(outcome.error.kind);
    }
  }
}

function describe(outcome: Outcome): string {
  if (outcome.kind === "response") {
    return `status ${outcome.response.status}`;
  }
  return outcome.error instanceof Error
    ? outcome.error.message
    : String(outcome.error);
}

/** Wait before retry number `retry` (1 = the wait after the first try). */
function backoffMs(config: RetryConfig, retry: number): number {
  switch (config.backoff) {
    case "fixed": {
      return config.initial_delay;
    }
    case "exponential": {
      return config.initial_delay * 2 ** (retry - 1);
    }
    default: {
      throw new UnreachableCaseError(config.backoff);
    }
  }
}

/** Let a response we won't use finish quietly, so its connection can be reused. */
function discard(outcome: Outcome): void {
  if (outcome.kind === "response" && outcome.response.body.kind === "stream") {
    outcome.response.body.stream.resume();
  }
}

export function createRetryStage(
  route: RouteConfig,
  { sleep }: StageDeps,
): Middleware | undefined {
  const config = route.retry;
  if (!config) {
    return undefined;
  }
  const retryOn = new Set(config.on);

  async function wait(ctx: RequestContext, ms: number): Promise<void> {
    try {
      await sleep(ms, ctx.signal);
    } catch (cause) {
      throw new UpstreamError({
        kind: "aborted",
        message: `client disconnected while waiting to retry ${ctx.request.method} ${route.path}`,
        cause,
      });
    }
  }

  return async (ctx, next) => {
    const buffered = await bufferBody({
      body: ctx.request.body,
      headers: ctx.request.headers,
      maxBytes: MAX_BODY_BYTES,
      signal: ctx.signal,
    });
    if (buffered.kind === "too_large") {
      // Node discards the unread rest of the upload after responding, so the
      // client can finish sending and read the 413 instead of being reset.
      return errorResponse({ status: 413, error: "payload_too_large" });
    }
    // Inner stages may rewrite ctx.request; every try starts from this copy.
    const request = { ...ctx.request, body: buffered.body };

    /** Make try number `tries`, then retry until it succeeds or tries run out. */
    const run = async (tries: number): Promise<GatewayResponse> => {
      ctx.request = request;
      const outcome = await attempt(next);
      const status = retryableStatus(outcome);
      if (
        tries >= config.attempts ||
        status === undefined ||
        !retryOn.has(status)
      ) {
        return unwrap(outcome);
      }
      discard(outcome);
      const delayMs = backoffMs(config, tries);
      console.warn(
        `retrying ${request.method} ${route.path} after ${describe(outcome)} ` +
          `(try ${tries + 1} of ${config.attempts} in ${delayMs}ms)`,
      );
      await wait(ctx, delayMs);
      return run(tries + 1);
    };

    return run(1);
  };
}
