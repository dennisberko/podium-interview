// Loads gateway.yaml in three stages:
//   1. parse    — `yaml` turns text into plain JS (YAML 1.2, so `on:` stays a string key)
//   2. validate — zod checks shape and types, converts durations to ms,
//                 and normalizes single-url upstreams into a one-entry target list
//   3. resolve  — global defaults (timeout, rate limit) are copied into each route
//
// The rest of the gateway only ever sees the resolved `GatewayConfig`.
// All durations in it are milliseconds.

import { readFileSync } from "node:fs";
import { isNode, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "gateway.yaml";

// ── Primitives ───────────────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** "500ms" | "30s" | "2m" | "1h" → milliseconds */
const Duration = z.string().transform((value, ctx) => {
  const match = DURATION_RE.exec(value);
  const unitMs = UNIT_MS[match?.[2] ?? ""];
  if (!match || unitMs === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `invalid duration ${JSON.stringify(value)}; expected e.g. "500ms", "30s", "2m", "1h"`,
    });
    return z.NEVER;
  }
  return Number(match[1]) * unitMs;
});

export const PLACEHOLDERS = [
  "$request_time",
  "$response_time",
  "$body",
  "$route_path",
] as const;
export const LITERAL_PREFIX = "$literal:";

/** A string that, if it starts with `$`, must be a known placeholder. */
const Template = z
  .string()
  .refine(
    (s) =>
      !s.startsWith("$") ||
      s.startsWith(LITERAL_PREFIX) ||
      (PLACEHOLDERS as readonly string[]).includes(s),
    {
      error: (issue) =>
        `unknown placeholder ${JSON.stringify(issue.input)}; expected one of ${[
          ...PLACEHOLDERS,
          `${LITERAL_PREFIX}<value>`,
        ].join(", ")}`,
    },
  );

export interface EnvelopeTemplate {
  [key: string]: string | EnvelopeTemplate;
}
const Envelope: z.ZodType<EnvelopeTemplate> = z.lazy(() =>
  z.record(z.string(), z.union([Template, Envelope])),
);

const HttpUrl = z.url({ protocol: /^https?$/ });

// ── Sections ─────────────────────────────────────────────────────────────────

const RateLimit = z.strictObject({
  requests: z.number().int().positive(),
  window: Duration,
  strategy: z.enum(["fixed_window", "sliding_window"]),
  per: z.enum(["ip", "global"]),
});

// `url: X` becomes `targets: [{ url: X, weight: 1 }]` so the proxy has one shape.
const SingleUpstream = z
  .strictObject({ url: HttpUrl, timeout: Duration.optional() })
  .transform(({ url, timeout }) => ({
    targets: [{ url, weight: 1 }],
    balance: "round_robin" as const,
    timeout,
  }));

// Weights only mean something for `weighted_round_robin`; a weight under
// `round_robin` would silently do nothing, so it is rejected instead.
const BalancedUpstream = z
  .strictObject({
    targets: z
      .array(
        z.strictObject({
          url: HttpUrl,
          weight: z.number().int().positive().default(1),
        }),
      )
      .min(1),
    balance: z.enum(["round_robin", "weighted_round_robin"]),
    timeout: Duration.optional(),
  })
  .superRefine(({ targets, balance }, ctx) => {
    if (balance !== "round_robin") {
      return;
    }
    targets.forEach(({ weight }, index) => {
      if (weight !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", index, "weight"],
          message: `weight ${weight} has no effect with balance "round_robin"; use "weighted_round_robin" or remove it`,
        });
      }
    });
  });

const Upstream = z.union([SingleUpstream, BalancedUpstream]);

const HeaderTransform = z.strictObject({
  add: z.record(z.string(), Template).default({}),
  remove: z.array(z.string()).default([]),
});

const Retry = z.strictObject({
  attempts: z.number().int().min(1),
  backoff: z.enum(["fixed", "exponential"]),
  initial_delay: Duration,
  on: z.array(z.number().int().min(100).max(599)).min(1),
});

const HealthCheck = z.strictObject({
  path: z.string().startsWith("/"),
  interval: Duration,
  unhealthy_threshold: z.number().int().positive(),
});

const Auth = z.strictObject({
  type: z.literal("api_key"),
  header: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1),
});

const CircuitBreaker = z.strictObject({
  threshold: z.number().int().positive(),
  window: Duration,
  cooldown: Duration,
});

const Route = z.strictObject({
  // "/api/users/" and "/api/users" are the same route; "/" stays "/".
  path: z
    .string()
    .startsWith("/")
    .transform((path) => path.replace(/\/+$/, "") || "/"),
  methods: z
    .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]))
    .min(1),
  strip_prefix: z.boolean().default(false),
  upstream: Upstream,
  rate_limit: RateLimit.optional(),
  retry: Retry.optional(),
  health_check: HealthCheck.optional(),
  request_transform: z
    .strictObject({
      headers: HeaderTransform.optional(),
      body: z
        .strictObject({ mapping: z.record(z.string(), Template) })
        .optional(),
    })
    .optional(),
  response_transform: z
    .strictObject({
      headers: HeaderTransform.optional(),
      body: z.strictObject({ envelope: Envelope }).optional(),
    })
    .optional(),
  auth: Auth.optional(),
  circuit_breaker: CircuitBreaker.optional(),
});

export const ConfigSchema = z
  .strictObject({
    gateway: z.strictObject({
      port: z.number().int().min(1).max(65_535),
      global_timeout: Duration,
      global_rate_limit: RateLimit.optional(),
    }),
    routes: z.array(Route),
  })
  .superRefine((config, ctx) => {
    for (const { index, message } of overlappingRoutes(config.routes)) {
      ctx.addIssue({
        code: "custom",
        path: ["routes", index, "path"],
        message,
      });
    }
  });

/**
 * Several routes may share a path if their methods don't overlap
 * (GET /x -> A, POST /x -> B). Two routes claiming the same path + method
 * would make routing ambiguous, so that's a config error.
 */
function overlappingRoutes(
  routes: readonly { path: string; methods: readonly string[] }[],
): { index: number; message: string }[] {
  const owners = new Map<string, number>();
  const problems: { index: number; message: string }[] = [];
  routes.forEach(({ path, methods }, index) => {
    const clashes = methods.filter((method) => owners.has(`${method} ${path}`));
    const [first] = clashes;
    if (first !== undefined) {
      const owner = owners.get(`${first} ${path}`) ?? 0;
      problems.push({
        index,
        message: `duplicate route path ${JSON.stringify(path)} for ${clashes.join(", ")} (already handled by routes.${owner})`,
      });
    }
    for (const method of methods) {
      if (!owners.has(`${method} ${path}`)) {
        owners.set(`${method} ${path}`, index);
      }
    }
  });
  return problems;
}

export type ParsedConfig = z.output<typeof ConfigSchema>;
type ParsedRoute = ParsedConfig["routes"][number];

// ── Resolved config (what the gateway uses) ──────────────────────────────────

export type RateLimitConfig = z.output<typeof RateLimit>;
export type UpstreamConfig = Omit<z.output<typeof BalancedUpstream>, "timeout">;

export interface RouteConfig extends Omit<
  ParsedRoute,
  "upstream" | "rate_limit"
> {
  upstream: UpstreamConfig;
  timeout_ms: number;
  /** `undefined` means the route is not rate limited. */
  rate_limit: RateLimitConfig | undefined;
}

export interface GatewayConfig {
  port: number;
  routes: RouteConfig[];
}

function resolve({ gateway, routes }: ParsedConfig): GatewayConfig {
  return {
    port: gateway.port,
    routes: routes.map(
      ({ upstream: { timeout, ...upstream }, rate_limit, ...route }) => ({
        ...route,
        upstream,
        timeout_ms: timeout ?? gateway.global_timeout,
        rate_limit: rate_limit ?? gateway.global_rate_limit,
      }),
    ),
  };
}

// ── Loading & errors ─────────────────────────────────────────────────────────

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid gateway config:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

interface Problem {
  path: PropertyKey[];
  message: string;
}

/**
 * zod reports a failed union as one "Invalid input" issue that holds every
 * branch's errors. Replace it with the errors of the branch that came closest
 * (fewest issues), so a bad upstream url says "Invalid URL" instead.
 */
function flattenUnions(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): Problem[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    const branches: readonly z.core.$ZodIssue[][] =
      issue.code === "invalid_union" ? issue.errors : [];
    const [first, ...rest] = branches;
    if (!first) {
      return [{ path, message: issue.message }];
    }
    const closest = rest.reduce(
      (best, branch) => (branch.length < best.length ? branch : best),
      first,
    );
    return flattenUnions(closest, path);
  });
}

/** Parse, validate and resolve config text. Throws `ConfigError`. */
export function parseConfig(
  text: string,
  source = DEFAULT_CONFIG_PATH,
): GatewayConfig {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    throw new ConfigError(doc.errors.map((e) => `${source}: ${e.message}`));
  }

  const result = ConfigSchema.safeParse(doc.toJS());
  if (!result.success) {
    throw new ConfigError(
      flattenUnions(result.error.issues).map(({ path, message }) => {
        const dotted = path.map(String).join(".") || "(root)";
        return `${source}${locate(path)} ${dotted}: ${message}`;
      }),
    );
  }
  return resolve(result.data);

  /** Line/column of the deepest node on `path` that exists in the YAML. */
  function locate(path: readonly PropertyKey[]): string {
    for (let depth = path.length; depth >= 0; depth--) {
      const node = doc.getIn(path.slice(0, depth), true);
      if (isNode(node) && node.range) {
        const { line, col } = lineCounter.linePos(node.range[0]);
        return `:${line}:${col}`;
      }
    }
    return "";
  }
}

/** Read and load the config file. Call once at startup, before listening. */
export function loadConfig(path = DEFAULT_CONFIG_PATH): GatewayConfig {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError([`cannot read ${path}: ${reason}`]);
  }
  return parseConfig(text, path);
}
