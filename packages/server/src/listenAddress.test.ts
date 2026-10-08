import { describe, it, expect } from "vitest";
import { DEFAULT_HOST, resolveListenAddress } from "./listenAddress.js";

describe("resolveListenAddress", () => {
  it("listens on 127.0.0.1:3001 by default (0.0.0.0 before 0.5.2)", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(resolveListenAddress({})).toEqual({ host: "127.0.0.1", port: 3001, hostIsDefault: true, sidecar: false });
  });

  it("treats a blank PYRODECK_HOST as unset", () => {
    expect(resolveListenAddress({ PYRODECK_HOST: "  " })).toMatchObject({ host: "127.0.0.1", hostIsDefault: true });
  });

  it("serves a LAN with PYRODECK_HOST=0.0.0.0", () => {
    expect(resolveListenAddress({ PYRODECK_HOST: "0.0.0.0", PYRODECK_PORT: "8080" })).toEqual({
      host: "0.0.0.0",
      port: 8080,
      hostIsDefault: false,
      sidecar: false,
    });
    expect(resolveListenAddress({ PYRODECK_HOST: "::" }).host).toBe("::");
  });

  it("keeps the desktop sidecar on loopback and a free port whatever is set", () => {
    expect(resolveListenAddress({ PYRODECK_SIDECAR: "1", PYRODECK_HOST: "0.0.0.0", PYRODECK_PORT: "3001" })).toEqual({
      host: "127.0.0.1",
      port: 0,
      hostIsDefault: false,
      sidecar: true,
    });
  });

  it.each(["abc", "70000", "-1", "30o1"])("refuses PYRODECK_PORT=%s", (port) => {
    expect(() => resolveListenAddress({ PYRODECK_PORT: port })).toThrow(/PYRODECK_PORT/);
  });
});
