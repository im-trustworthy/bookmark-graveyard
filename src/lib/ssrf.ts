import "server-only";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// The guard for a server-side fetch of a URL that someone else chose, here an
// OAuth client's metadata document (draft-ietf-oauth-client-id-metadata-
// document §8.6: never fetch a URL that resolves to a special-use address,
// RFC 6890). The approach is ingest.ts's: refuse a reserved name or a
// special-use IP literal outright, resolve a real hostname and refuse it if
// ANY address it resolves to is special-use, and never follow a redirect. The
// address list is stricter than ingest's isPrivateHost: it also covers shared
// address space, documentation, benchmarking, multicast and reserved ranges,
// and the IPv6 transition prefixes that can wrap a private IPv4 address.
//
// Residual risk, the same one ingest.ts accepts: the check and fetch()'s own
// resolution are two lookups, so a DNS-rebinding host that flips its record
// between them could still reach a private address. Closing that means pinning
// the vetted address in a custom dispatcher. The caller never shows the
// response to anyone, only one of its own fixed sentences, which leaves a
// rebinding attacker a blind GET at best.

const SPECIAL_USE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, where cloud metadata services live
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
] as const) {
  SPECIAL_USE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible block
  ["64:ff9b::", 96], // NAT64, which can wrap any IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, ...)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which can wrap any IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  SPECIAL_USE.addSubnet(network, prefix, "ipv6");
}
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by the IPv4 rules:
// BlockList checks the embedded address against the IPv4 subnets.

// Names that never lead anywhere public (RFC 6761, RFC 6762, RFC 8375), and
// the suffix cloud providers use for internal hosts.
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

// URL.hostname wraps IPv6 literals in brackets ("[::1]"); dns.lookup() results don't.
const stripBrackets = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

/** Whether an IP address (v4, v6 or IPv4-mapped v6) is special-use: anything but a public unicast address. */
export function isSpecialUseAddress(address: string): boolean {
  const bare = stripBrackets(address);
  const family = isIP(bare);
  if (family === 4) return SPECIAL_USE.check(bare, "ipv4");
  if (family === 6) return SPECIAL_USE.check(bare.split("%")[0], "ipv6");
  return false;
}

/**
 * Whether a hostname, as URL.hostname gives it, can't be public from its text
 * alone: a special-use IP literal, localhost or a reserved suffix, or a single
 * label (which a resolver may complete with an internal search domain).
 */
export function isReservedHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, "");
  if (isIP(host)) return isSpecialUseAddress(host);
  if (!host.includes(".")) return true;
  return host === "localhost" || RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** What a hostname turned out to be: safe to fetch, special-use, or not found. */
export type HostCheck = "public" | "special-use" | "unresolvable";

/**
 * Whether `hostname` (as URL.hostname gives it) may be fetched: never a
 * reserved name or special-use literal, and for a real name, never when ANY
 * address it resolves to is special-use. An IP literal needs no lookup.
 */
export async function checkPublicHost(hostname: string): Promise<HostCheck> {
  if (isReservedHostname(hostname)) return "special-use";
  const bare = stripBrackets(hostname);
  if (isIP(bare)) return "public";
  let records: { address: string }[];
  try {
    records = await lookup(bare, { all: true });
  } catch {
    return "unresolvable";
  }
  if (records.length === 0) return "unresolvable";
  return records.some(({ address }) => isSpecialUseAddress(address)) ? "special-use" : "public";
}
