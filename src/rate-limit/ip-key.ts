// Bucket key for `per: ip`. Raw address strings don't identify a client well:
//   - IPv4-mapped IPv6 ("::ffff:1.2.3.4") is the same client as "1.2.3.4",
//     and which form the socket reports depends on how the server listens.
//   - One IPv6 subscriber usually gets a whole /64 and can rotate through it,
//     so each address would get a fresh quota.
// So IPv4 addresses key as themselves and IPv6 addresses key by their /64.
//
// The key is the socket peer. Behind a reverse proxy every client shares the
// proxy's address; trusting X-Forwarded-For is not supported.

import { isIPv4, isIPv6 } from "node:net";

const IPV6_WORDS = 8;
/** Words kept for an IPv6 key: 4 × 16 bits = /64. */
const PREFIX_WORDS = 4;
/** The "ffff" word in "::ffff:a.b.c.d". */
const MAPPED_IPV4_MARKER = 65_535;
/** One IPv4 octet's range; two octets make an IPv6 word. */
const OCTET = 256;

export function ipBucketKey(ip: string): string {
  if (!isIPv6(ip)) {
    // IPv4, or not an address at all (e.g. "" when the socket is gone).
    return ip;
  }
  const words = ipv6Words(ip);
  const mapped = mappedIpv4(words);
  if (mapped !== undefined) {
    return mapped;
  }
  return `${words
    .slice(0, PREFIX_WORDS)
    .map((word) => word.toString(16))
    .join(":")}::/64`;
}

/** "1.2.3.4" -> "102:304", so a dotted tail can be parsed as two hex words. */
function ipv4AsHexWords(ipv4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);
  return `${(a * OCTET + b).toString(16)}:${(c * OCTET + d).toString(16)}`;
}

/** "db8:1" -> [0xdb8, 1]; "" -> []. */
function parseHexWords(part: string): number[] {
  return part === ""
    ? []
    : part.split(":").map((word) => Number.parseInt(word, 16));
}

/** A valid IPv6 address as its eight 16-bit words ("::" expanded, zone dropped). */
function ipv6Words(ip: string): number[] {
  const [address = ""] = ip.split("%");
  const tailStart = address.lastIndexOf(":") + 1;
  const tail = address.slice(tailStart);
  const hex = isIPv4(tail)
    ? `${address.slice(0, tailStart)}${ipv4AsHexWords(tail)}`
    : address;
  const [head = "", rest] = hex.split("::");
  const headWords = parseHexWords(head);
  const restWords = rest === undefined ? [] : parseHexWords(rest);
  const zeros = Array.from<number>({
    length: IPV6_WORDS - headWords.length - restWords.length,
  }).fill(0);
  return [...headWords, ...zeros, ...restWords];
}

/** "::ffff:a.b.c.d" (in any spelling) -> "a.b.c.d"; otherwise `undefined`. */
function mappedIpv4(words: readonly number[]): string | undefined {
  const [w0, w1, w2, w3, w4, w5, w6 = 0, w7 = 0] = words;
  const isMapped =
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    w5 === MAPPED_IPV4_MARKER;
  if (!isMapped) {
    return undefined;
  }
  return [
    Math.floor(w6 / OCTET),
    w6 % OCTET,
    Math.floor(w7 / OCTET),
    w7 % OCTET,
  ].join(".");
}
