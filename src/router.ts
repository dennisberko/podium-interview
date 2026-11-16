// Maps a request (path + method) to a configured route.
//
// Matching rules:
//   - A route path is a prefix that only matches on a segment boundary:
//     "/api/users" matches "/api/users" and "/api/users/42", not "/api/usersX".
//     "/" matches everything. (Config loading strips trailing slashes.)
//   - The longest matching path wins, so config order doesn't matter.
//   - Several routes may share a path with disjoint methods (config validation
//     guarantees no overlap). The method picks the route among them; if none
//     accepts it the result is 405. We never fall back to a shorter path.
//   - HEAD is served by the GET route unless a route lists HEAD explicitly.

import type { RouteConfig } from "./config.ts";

export type RouteLookup =
  | {
      kind: "matched";
      route: RouteConfig;
      /** Path to send upstream: `strip_prefix` applied, always starts with "/". */
      upstreamPath: string;
    }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" };

export type Router = (path: string, method: string) => RouteLookup;

interface PathGroup {
  prefix: string;
  routes: RouteConfig[];
}

const ROOT = "/";

function matches(prefix: string, path: string): boolean {
  return prefix === ROOT || path === prefix || path.startsWith(`${prefix}/`);
}

function accepts(route: RouteConfig, method: string): boolean {
  return route.methods.some((m) => m === method);
}

function routeForMethod(
  routes: readonly RouteConfig[],
  method: string,
): RouteConfig | undefined {
  const explicit = routes.find((route) => accepts(route, method));
  if (explicit || method !== "HEAD") {
    return explicit;
  }
  return routes.find((route) => accepts(route, "GET"));
}

/** Every method served at a path, for the 405 `Allow` header. */
function allowedMethods(routes: readonly RouteConfig[]): string[] {
  const methods = new Set<string>(routes.flatMap((route) => route.methods));
  if (methods.has("GET")) {
    methods.add("HEAD");
  }
  return [...methods];
}

function upstreamPathFor(route: RouteConfig, path: string): string {
  if (!route.strip_prefix || route.path === ROOT) {
    return path;
  }
  return path.slice(route.path.length) || ROOT;
}

function groupByPath(routes: readonly RouteConfig[]): PathGroup[] {
  const groups = new Map<string, RouteConfig[]>();
  for (const route of routes) {
    groups.set(route.path, [...(groups.get(route.path) ?? []), route]);
  }
  return [...groups]
    .map(([prefix, grouped]) => ({ prefix, routes: grouped }))
    .toSorted((a, b) => b.prefix.length - a.prefix.length);
}

export function createRouter(routes: readonly RouteConfig[]): Router {
  const groups = groupByPath(routes);

  return (path, method) => {
    const group = groups.find(({ prefix }) => matches(prefix, path));
    if (!group) {
      return { kind: "not_found" };
    }
    const route = routeForMethod(group.routes, method);
    if (!route) {
      return {
        kind: "method_not_allowed",
        allow: allowedMethods(group.routes),
      };
    }
    return {
      kind: "matched",
      route,
      upstreamPath: upstreamPathFor(route, path),
    };
  };
}
