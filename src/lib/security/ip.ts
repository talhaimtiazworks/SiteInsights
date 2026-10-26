import ipaddr from "ipaddr.js";

/**
 * Extra IPv4 networks blocked in addition to everything ipaddr.js does not
 * classify as plain "unicast" (private, loopback, link-local incl. cloud
 * metadata 169.254.169.254, CGNAT, multicast, reserved, broadcast …).
 */
const EXTRA_BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const EXTRA_BLOCKED_V6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
];

function isPublicV4(addr: ipaddr.IPv4): boolean {
  if (addr.range() !== "unicast") return false;
  for (const [net, bits] of EXTRA_BLOCKED_V4) {
    if (addr.match(ipaddr.IPv4.parse(net), bits)) return false;
  }
  return true;
}

/** Returns true only for globally routable unicast addresses. */
export function isPublicIp(ip: string): boolean {
  const cleaned = ip.replace(/^\[|\]$/g, "");
  // Reject zone IDs (fe80::1%eth0) outright.
  if (cleaned.includes("%")) return false;
  if (!ipaddr.isValid(cleaned)) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(cleaned);
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicV4(v6.toIPv4Address());
    if (v6.range() !== "unicast") return false;
    for (const [net, bits] of EXTRA_BLOCKED_V6) {
      if (v6.match(ipaddr.IPv6.parse(net), bits)) return false;
    }
    return true;
  }
  return isPublicV4(addr as ipaddr.IPv4);
}

/** True when the string is an IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(host.replace(/^\[|\]$/g, ""));
}
