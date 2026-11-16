// Small response helpers shared by every handler, so all gateway-generated
// responses (health, errors) have the same shape and headers.

import type { ServerResponse } from "node:http";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

interface JsonResponse {
  status: number;
  body: JsonValue;
  headers?: Record<string, string>;
}

export function sendJson(
  res: ServerResponse,
  { status, body, headers = {} }: JsonResponse,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Gateway-generated error, e.g. `{ "error": "not_found" }`. */
export function sendError(
  res: ServerResponse,
  {
    status,
    error,
    headers,
  }: { status: number; error: string } & Pick<JsonResponse, "headers">,
): void {
  sendJson(res, {
    status,
    body: { error },
    ...(headers ? { headers } : {}),
  });
}
