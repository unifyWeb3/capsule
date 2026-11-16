/**
 * Fetching a log somebody else published.
 *
 * We fetch a URL a third party gives us, so this is the one place in the
 * project where the input is hostile. The rules:
 *
 *   - https only, and the host must not be an address literal;
 *   - every resolved address must be a public unicast address, checked after
 *     resolution so a DNS name cannot point at 127.0.0.1 or a metadata
 *     service;
 *   - the connection is made to the address that was checked, not to whatever
 *     the name resolves to a second later;
 *   - redirects are followed by hand, and each hop is checked again;
 *   - the body is capped, and the read is timed out.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class UnsafeUrlError extends Error {}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 3;

/** Hostnames that must never be fetched, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

/**
 * Expands an IPv6 address into its eight 16-bit groups, or returns null when
 * the string is not a valid IPv6 address. Handles `::` compression and an
 * embedded dotted-quad tail (`::ffff:127.0.0.1`).
 */
function parseIPv6Groups(address: string): number[] | null {
  let input = address.trim().toLowerCase();
  if (input.length === 0 || input.length > 45) return null;

  // An embedded dotted quad (`::ffff:127.0.0.1`): expand it to two hextets.
  const lastColon = input.lastIndexOf(":");
  const maybeV4 = input.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    const octets = maybeV4.split(".").map((part) => Number(part));
    const hi = ((octets[0]! << 8) | octets[1]!) & 0xffff;
    const lo = ((octets[2]! << 8) | octets[3]!) & 0xffff;
    input = `${input.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  if (!/^[0-9a-f:]+$/.test(input)) return null;

  const halves = input.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (text: string): number[] =>
    text.split(":").map((group) => Number.parseInt(group, 16));

  let groups: number[];
  if (halves.length === 2) {
    const head = halves[0] ? parseGroups(halves[0]!) : [];
    const tail = halves[1] ? parseGroups(halves[1]!) : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    groups = parseGroups(input);
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8) return null;
  for (const group of groups) {
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return null;
  }
  return groups;
}

/** True when a dotted-quad IPv4 address is public unicast. */
function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local, and the metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier grade NAT
  if (a === 192 && b === 0) return false; // IETF protocol assignments (192.0.0.0/24), incl. documentation 192.0.2.0/24
  if (a === 192 && b === 88 && parts[2] === 99) return false; // deprecated 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && parts[2] === 100) return false; // documentation range 198.51.100.0/24
  if (a === 203 && b === 0 && parts[2] === 113) return false; // documentation range 203.0.113.0/24
  if (a >= 224) return false; // multicast and reserved
  return true;
}

/** True when the last 32 bits of an IPv6 address hold a public IPv4 address. */
function embeddedIPv4IsPublic(groups: number[]): boolean {
  const hi = groups[groups.length - 2]!;
  const lo = groups[groups.length - 1]!;
  return isPublicIPv4(
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`,
  );
}

/**
 * True when an address is a public unicast address we may connect to.
 *
 * Everything else is refused: loopback, private ranges, link-local, carrier
 * grade NAT, multicast, reserved, documentation ranges, addresses that carry
 * an IPv4 address inside them (IPv4-mapped, NAT64, 6to4, IPv4-compatible)
 * unless the embedded address is itself public, and the IPv6 equivalents.
 * The cloud metadata addresses are inside the link-local and private ranges,
 * so they are covered.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isPublicIPv4(address);
  }

  if (version === 6) {
    const groups = parseIPv6Groups(address);
    if (!groups) return false;
    const [g0, g1, g2, g3, g4, g5] = groups as [
      number, number, number, number, number, number, number, number,
    ];

    // :: (unspecified) and ::1 (loopback)
    if (groups.every((group) => group === 0)) return false;
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return embeddedIPv4IsPublic(groups); // ::a.b.c.d — IPv4-compatible
    }

    // IPv4-mapped ::ffff:a.b.c.d
    if (
      g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
    ) {
      return embeddedIPv4IsPublic(groups);
    }

    // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
    if (g0 === 0x0064 && g1 === 0xff9b) return false;
    // 6to4 2002::/16 — embeds an IPv4 address in the second and third hextets
    if (g0 === 0x2002) {
      const hi = g1;
      const lo = g2;
      return isPublicIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // Teredo 2001:0000::/32 embeds the server address; refuse it outright
    if (g0 === 0x2001 && g1 === 0x0000) return false;
    // Discard-only 100::/64
    if (g0 === 0x0100 && g1 === 0x0000 && g2 === 0 && g3 === 0) return false;
    // Documentation 2001:db8::/32 (RFC 3849)
    if (g0 === 0x2001 && g1 === 0x0db8) return false;
    // Documentation 3fff::/20 (RFC 9602)
    if ((g0 & 0xfff0) === 0x3ff0) return false;

    if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((g0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
    return true;
  }

  return false;
}

/** A URL we have checked, and the address we are allowed to connect to. */
export interface ResolvedUrl {
  url: URL;
  /** The address that was checked. The connection goes here, not to a name. */
  address: string;
  family: 4 | 6;
}

/**
 * Checks a URL and pins the address it may be connected to.
 *
 * The pin is the point. If we checked the name and then let the HTTP client
 * resolve it again, a hostile DNS server could answer with a public address the
 * first time and a private one the second time — the classic rebinding window.
 * So the address is resolved once, checked, and handed to the socket.
 *
 * The certificate is still checked against the *name*: the TLS server name stays
 * the hostname, so a pinned connection cannot be used to present somebody
 * else's certificate.
 */
export async function resolvePublic(rawUrl: string): Promise<ResolvedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("that is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("only https URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("a URL with credentials in it cannot be fetched");
  }
  // The WHATWG parser keeps the brackets on an IPv6 literal; they are not part
  // of the address. Trailing dots are dropped as well.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeUrlError("that host cannot be fetched");
  }
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (!isPublicAddress(host)) {
      throw new UnsafeUrlError("that address is not a public address");
    }
    return { url, address: host, family: literalFamily as 4 | 6 };
  }
  const addresses = await dnsLookup(host, { all: true }).catch(
    () => [] as Array<{ address: string; family: number }>,
  );
  if (!addresses.length) {
    throw new UnsafeUrlError("that host does not resolve");
  }
  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) {
      throw new UnsafeUrlError("that host resolves to a non-public address");
    }
  }
  // Prefer IPv4: it is what a host publishes first, and it keeps the pinned
  // lookup simple.
  const chosen =
    addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { url, address: chosen.address, family: chosen.family as 4 | 6 };
}

/** Rejects a URL that is not one we are willing to fetch. */
export async function assertFetchable(rawUrl: string): Promise<URL> {
  return (await resolvePublic(rawUrl)).url;
}

/**
 * A DNS lookup that always answers with the address we already checked.
 *
 * The HTTP client calls this instead of resolving the name, so there is no
 * second resolution and therefore no window.
 */
export function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const done = callback as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void;
    const wantsAll = (options as { all?: boolean } | undefined)?.all === true;
    if (wantsAll) {
      done(null, [{ address, family }] as never, family);
      return;
    }
    done(null, address, family);
  }) as unknown as LookupFunction;
}

/**
 * Fetches a text document, following redirects by hand so every hop is
 * checked.
 */
export async function fetchText(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<{ url: string; body: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolvePublic(current);
    const { status, headers, body } = await readOnce(resolved, maxBytes, timeoutMs);

    if (status >= 300 && status < 400) {
      const location = headers.location;
      if (!location) {
        throw new UnsafeUrlError("the server redirected without saying where");
      }
      current = new URL(location, resolved.url).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`the log host answered HTTP ${status}`);
    }
    return { url: current, body };
  }
  throw new UnsafeUrlError("too many redirects");
}

/**
 * Whether a failure is a timeout.
 *
 * A timeout is the one failure worth trying again: a cold edge, a slow public
 * host, a first TLS handshake on a slow link. A refusal, a 404 or an oversized
 * body is the host's answer, and repeating the question does not change it.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

/**
 * Runs an operation, trying it once more when it fails with a timeout.
 *
 * This exists because of what the agent version of the stranger test found:
 * the first `verify_record` call came back with "the request timed out", and
 * the second call, seconds later, verified the same log. A judge who gives up
 * on the first answer never sees the proof. The retry is the whole difference
 * between "flaky" and "works".
 *
 * The operation is tried at most `attempts` times in total. A timeout on the
 * last attempt is rethrown as it was.
 */
export async function withTimeoutRetry<T>(
  operation: () => Promise<T>,
  attempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error)) throw error;
    }
  }
  throw lastError;
}

interface ResponseHead {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTPS request, to the address we checked, with the name still in TLS. */
function readOnce(
  resolved: ResolvedUrl,
  maxBytes: number,
  timeoutMs: number,
): Promise<ResponseHead> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      resolved.url,
      {
        method: "GET",
        // The connection goes to the address that was checked.
        lookup: createPinnedLookup(resolved.address, resolved.family),
        headers: { accept: "text/plain, application/json, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            reject(new Error("the log is larger than we will read"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as ResponseHead["headers"],
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("the request timed out")));
    request.on("error", reject);
    request.end();
  });
}
