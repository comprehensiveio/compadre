import { describe, expect, it } from "vite-plus/test";

import { controllerRequestFor } from "./CompadreTriggeredPrompts.ts";

const ID = "6f76f496-6f37-4c4c-9e2f-000000000000";

describe("controllerRequestFor", () => {
  it("maps list to the bare collection GET", () => {
    expect(controllerRequestFor("list", {}, "user-1")).toEqual({
      method: "GET",
      path: "/triggers/api/prompts",
    });
  });

  it("stamps the acting user as createdBy on create", () => {
    expect(controllerRequestFor("create", { name: "Daily" }, "user-1")).toEqual({
      method: "POST",
      path: "/triggers/api/prompts",
      body: { name: "Daily", createdBy: "user-1" },
    });
    expect(controllerRequestFor("create", { name: "Daily" }, undefined)).toEqual({
      method: "POST",
      path: "/triggers/api/prompts",
      body: { name: "Daily" },
    });
  });

  it("requires a prompt UUID for row-scoped actions", () => {
    expect(controllerRequestFor("run", { id: "nope" }, undefined)).toEqual({
      error: "id must be a triggered prompt UUID",
    });
    expect(controllerRequestFor("update", { id: ID, name: "x" }, "user-1")).toEqual({
      method: "POST",
      path: `/triggers/api/prompts/${ID}`,
      body: { name: "x" },
    });
    expect(controllerRequestFor("enable", { id: ID, enabled: false }, undefined)).toEqual({
      method: "POST",
      path: `/triggers/api/prompts/${ID}/enable`,
      body: { enabled: false },
    });
    expect(controllerRequestFor("delete", { id: ID }, undefined)).toEqual({
      method: "POST",
      path: `/triggers/api/prompts/${ID}/delete`,
      body: {},
    });
    expect(controllerRequestFor("run", { id: ID }, undefined)).toEqual({
      method: "POST",
      path: `/triggers/api/prompts/${ID}/run`,
      body: {},
    });
  });
});
