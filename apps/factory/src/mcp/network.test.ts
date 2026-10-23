import { expect, test } from "bun:test";
import { publicMCPAddress, secureMCPFetch } from "./network";

test("MCP egress rejects private, metadata, documentation and transition addresses", () => {
  for (const value of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "198.19.0.1",
    "192.0.2.1",
    "203.0.113.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:3::1",
  ])
    expect(publicMCPAddress(value)).toBe(false);
  for (const value of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    expect(publicMCPAddress(value)).toBe(true);
});

test("MCP egress refuses unsafe endpoints before network access", async () => {
  for (const url of [
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "http://example.com/mcp",
    "https://example.com:8443/mcp",
  ])
    await expect(secureMCPFetch(url)).rejects.toThrow();
});
