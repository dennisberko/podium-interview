// Small response helpers shared by every handler, so all gateway-generated
// responses (health, errors, rejections from pipeline stages) have the same
// shape and headers.

import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { GatewayResponse } from "./pipeline/context.ts";

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

/** Gateway-generated error, e.g. `{ "error": "not_found" }`. */
interface ErrorResponse extends Pick<JsonResponse, "status" | "headers"> {
  error: string;
}

interface Encoded {
  status: number;
  headers: OutgoingHttpHeaders;
  data: Buffer;
}

function encodeJson({ status, body, headers = {} }: JsonResponse): Encoded {
  const data = Buffer.from(JSON.stringify(body));
  return {
    status,
    headers: {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "content-length": data.length,
    },
    data,
  };
}

function errorBody({ status, error, headers }: ErrorResponse): JsonResponse {
  return { status, body: { error }, ...(headers ? { headers } : {}) };
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
  const { status, headers, data } = encodeJson(response);
  res.writeHead(status, headers);
  res.end(data);
}

export function sendError(res: ServerResponse, response: ErrorResponse): void {
  sendJson(res, errorBody(response));
}

/** A gateway-generated error as a pipeline result, for stages that reject a request. */
export function errorResponse(response: ErrorResponse): GatewayResponse {
  const { status, headers, data } = encodeJson(errorBody(response));
  return {
    source: "gateway",
    status,
    headers,
    body: { kind: "buffered", data },
  };
}
