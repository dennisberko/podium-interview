// Specs for `auth: { type: api_key }` (not implemented yet).

import { describe, it } from "node:test";

describe("api_key auth", () => {
  it.todo("forwards requests carrying any listed key in the configured header");
  it.todo("answers 401 { error: 'unauthorized' } when the header is missing");
  it.todo("answers 401 when the key is not listed");
  it.todo("matches the header name case-insensitively and the key exactly");
  it.todo("rejected requests never reach the upstream");
  it.todo("decide: strip the API key header before forwarding upstream");
  it.todo("routes without auth accept requests without a key");
  it.todo("/health never requires a key");
  it.todo(
    "decide: auth runs before rate limiting (unauthenticated traffic doesn't use quota)",
  );
});
