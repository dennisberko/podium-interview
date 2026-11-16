// Specs for `retry` (not implemented yet).

import { describe, it } from "node:test";

describe("retry: when", () => {
  it.todo("retries when the upstream answers a status listed in `on`");
  it.todo("does not retry statuses not listed in `on`");
  it.todo("stops after `attempts` total tries and relays the last response");
  it.todo("relays the first successful response and stops retrying");
  it.todo(
    "decide: retry connection errors and timeouts (502/504) or only listed statuses",
  );
  it.todo("decide: only retry idempotent methods, or every configured method");
});

describe("retry: backoff", () => {
  it.todo("fixed backoff waits initial_delay between every attempt");
  it.todo("exponential backoff doubles the delay each attempt (1s, 2s, 4s)");
  it.todo("waits are driven by the injected clock");
});

describe("retry: requests and timeouts", () => {
  it.todo("replays the same method, path, headers and body on each attempt");
  it.todo("decide: route timeout applies per attempt or across all attempts");
  it.todo("client disconnect cancels pending retries");
  it.todo("routes without retry make exactly one upstream attempt");
});
