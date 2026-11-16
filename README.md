# GatewayKit

An HTTP API gateway configured from a YAML file (routing, retries, rate limits, load balancing, health checks).

## Features

Implemented:

- [x] `GET /health` with `status` and `uptime_seconds`, always available
- [x] Config from a CLI argument or the `GATEWAY_CONFIG` env var, validated at startup
- [x] `gateway.port`
- [x] `gateway.global_timeout`, overridable per route with `upstream.timeout`
- [x] `gateway.global_rate_limit`, overridable per route with `rate_limit`
- [x] Route matching on `path` (longest prefix wins), 404 for unmatched paths
- [x] `methods`, 405 for methods a route doesn't list
- [x] `strip_prefix`
- [x] `upstream.url`
- [x] `upstream.targets` with `balance: round_robin | weighted_round_robin`
- [x] `rate_limit` with `strategy: fixed_window | sliding_window` and `per: ip | global`
- [x] `retry` with `backoff: fixed | exponential`, `initial_delay` and `on` status codes
- [x] `health_check` (`path`, `interval`, `unhealthy_threshold`)
- [x] `auth` with `type: api_key`

Not implemented (accepted by the config loader, but has no effect yet):

- [ ] `request_transform.headers` (`add`, `remove`, `$request_time`)
- [ ] `request_transform.body.mapping` (dot-notation paths, `$literal:`, `$request_time`)
- [ ] `response_transform.headers` (`add`, `remove`)
- [ ] `response_transform.body.envelope` (`$body`, `$response_time`, `$route_path`)
- [ ] `circuit_breaker` (`threshold`, `window`, `cooldown`, 503 with `retry_after`)

## Install

Requires Node.js 22+.

```bash
npm install
```

## Run

```bash
npm start
```

Reads `./gateway.yaml` by default and listens on the configured port (8080). To use another config:

```bash
npm start -- path/to/gateway.yaml   # or: GATEWAY_CONFIG=path/to/gateway.yaml npm start
```

Health check: `curl localhost:8080/health`

## Test

```bash
npm test                                         # all tests
node --import tsx --test test/retry.test.ts      # a single file
```

## Checks

```bash
npm run check    # format check, typecheck, lint
npm run format   # auto-format
```
