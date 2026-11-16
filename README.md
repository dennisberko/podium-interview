# GatewayKit

An HTTP API gateway configured from a YAML file (routing, retries, rate limits, load balancing, health checks).

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
