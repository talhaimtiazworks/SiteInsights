import { describe, expect, it } from "vitest";
import { isIpLiteral, isPublicIp } from "@/lib/security/ip";

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0", "255.255.255.255", "224.0.0.1", "192.0.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.5",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1",
  ])("blocks non-public address %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"])(
    "allows public address %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );

  it("rejects garbage", () => {
    expect(isPublicIp("not-an-ip")).toBe(false);
    expect(isPublicIp("")).toBe(false);
  });
});

describe("isIpLiteral", () => {
  it("recognises IPv4/IPv6 literals", () => {
    expect(isIpLiteral("8.8.8.8")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});
