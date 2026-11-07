import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchPluginHttp } from "../services/plugin-http.js";

describe("plugin HTTP destination security", () => {
  it("blocks localhost DNS and IPv4-mapped IPv6 before they reach a real loopback server", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("local secret fixture");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      // Prove that the fixture is reachable through the mapped address.
      const baseline = await fetch(`http://[::ffff:7f00:1]:${port}/private`);
      expect(await baseline.text()).toBe("local secret fixture");
      const receivedBeforeDenials = requests;

      for (const host of ["localhost", "127.0.0.1", "2130706433", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
        await expect(fetchPluginHttp(`http://${host}:${port}/private`)).rejects.toThrow(/private\/reserved/);
      }
      expect(requests).toBe(receivedBeforeDenials);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects private, shared, reserved, link-local and multicast destinations", async () => {
    for (const host of [
      "10.0.0.1", "172.16.0.1", "192.168.0.1", "100.64.0.1", "169.254.169.254",
      "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "[::1]", "[fc00::1]",
      "[fe90::1]", "[2001:db8::1]", "[ff02::1]", "[::ffff:6440:1]",
    ]) {
      await expect(fetchPluginHttp(`http://${host}/private`)).rejects.toThrow(/private\/reserved/);
    }
  });

  it("rejects non-HTTP protocols without contacting a destination", async () => {
    for (const url of ["file:///etc/passwd", "ftp://127.0.0.1/private", "data:text/plain,private"]) {
      await expect(fetchPluginHttp(url)).rejects.toThrow(/Disallowed protocol/);
    }
  });
});
