// Specs for `request_transform` / `response_transform` (not implemented yet).
// Placeholders: $request_time, $response_time, $body, $route_path, $literal:<v>.

import { describe, it } from "node:test";

describe("request transform: headers", () => {
  it.todo("adds static headers");
  it.todo(
    "$request_time injects the request timestamp (from the injected clock)",
  );
  it.todo("removes listed headers case-insensitively");
  it.todo("decide: add overwrites or appends to an existing client header");
});

describe("request transform: body mapping", () => {
  it.todo(
    "maps source paths to dot-notation destination paths (user.id <- userId)",
  );
  it.todo("$literal:<value> injects a literal string");
  it.todo("$request_time injects the request timestamp");
  it.todo("missing source fields are omitted, not null");
  it.todo("updates Content-Length to the rewritten body");
  it.todo("decide: non-JSON or invalid JSON bodies -> 400 or passed through");
  it.todo("requests without a body are not given one");
});

describe("response transform: headers", () => {
  it.todo("adds static headers to the upstream response");
  it.todo("removes listed headers (Server, X-Powered-By)");
});

describe("response transform: body envelope", () => {
  it.todo("wraps the parsed upstream JSON at $body");
  it.todo("fills $response_time and $route_path in nested objects");
  it.todo("updates Content-Length to the wrapped body");
  it.todo(
    "decide: non-JSON upstream bodies -> wrapped as string or passed through",
  );
  it.todo("keeps the upstream status code");
  it.todo("decide: transform upstream error responses (4xx/5xx) or not");
  it.todo("gateway-generated errors (502/504/429/...) are not transformed");
});
