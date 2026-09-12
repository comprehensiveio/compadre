import { describe, expect, it } from "vite-plus/test";
import { isDevProxiedPath } from "./devProxy.ts";

describe("hosted login in single-origin development", () => {
  it("routes login callbacks and logout to the central server", () => {
    expect(isDevProxiedPath("/auth/compadre/callback")).toBe(true);
    expect(isDevProxiedPath("/auth/compadre/logout")).toBe(true);
  });
  it("does not claim unrelated client routes", () => {
    expect(isDevProxiedPath("/auth/compadre-other")).toBe(false);
    expect(isDevProxiedPath("/settings/auth")).toBe(false);
  });
});
