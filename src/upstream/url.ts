import type { UpstreamRequest } from "../pipeline/context.ts";

/**
 * Upstream URL = target base URL (+ any base path) + request path + query.
 * `http://u/base` + `/users` -> `http://u/base/users`.
 */
export function upstreamUrl(
  base: URL,
  { path, search }: Pick<UpstreamRequest, "path" | "search">,
): URL {
  const url = new URL(base);
  url.pathname = base.pathname.replace(/\/+$/, "") + path;
  url.search = search;
  return url;
}
