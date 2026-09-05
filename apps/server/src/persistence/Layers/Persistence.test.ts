import { describe, expect, it } from "vite-plus/test";

import { assertSingleProcessReactors, resolvePersistenceMode } from "./Persistence.ts";

describe("persistence mode", () => {
  it("keeps SQLite as the local default", () => {
    expect(resolvePersistenceMode({})).toBe("sqlite");
  });

  it("selects PostgreSQL automatically when a URL is present", () => {
    expect(resolvePersistenceMode({ COMPADRE_T3_POSTGRES_URL: "postgresql://database/test" })).toBe(
      "postgres",
    );
  });

  it("requires a URL in explicit PostgreSQL mode", () => {
    expect(() => resolvePersistenceMode({ COMPADRE_T3_PERSISTENCE: "postgres" })).toThrow(
      "COMPADRE_T3_POSTGRES_URL is required",
    );
  });

  it("does not silently switch an explicit SQLite process", () => {
    expect(
      resolvePersistenceMode({
        COMPADRE_T3_PERSISTENCE: "sqlite",
        COMPADRE_T3_POSTGRES_URL: "postgresql://database/test",
      }),
    ).toBe("sqlite");
  });

  it("rejects unknown modes", () => {
    expect(() => resolvePersistenceMode({ COMPADRE_T3_PERSISTENCE: "memory" })).toThrow(
      "must be auto, sqlite, or postgres",
    );
  });
  it("requires an explicit single-process reactor deployment", () => {
    expect(() => assertSingleProcessReactors({})).toThrow("overlapping reactors are not supported");
    expect(() => assertSingleProcessReactors({ COMPADRE_T3_REACTOR_MODE: "leader" })).toThrow();
    expect(() =>
      assertSingleProcessReactors({ COMPADRE_T3_REACTOR_MODE: "single-process" }),
    ).not.toThrow();
  });
});
