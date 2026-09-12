import { test, afterAll } from "vite-plus/test";
import * as NodeModule from "node:module";
const require = NodeModule.createRequire(import.meta.url);
const assert = require("node:assert/strict");
const dns = require("node:dns");
const original = { lookup: dns.lookup, resolve4: dns.resolve4 };
const missing = Object.assign(new Error("missing"), { code: "ENOTFOUND" });
let resolved = [];
dns.lookup = (_host, _options, callback) => callback(missing);
dns.resolve4 = (host, callback) => {
  resolved.push(host);
  callback(null, ["192.0.2.1"]);
};
const { allow } = require("./dns.cjs");
allow("fixture.trycloudflare.com");
afterAll(() => Object.assign(dns, original));
test("does not intercept local or unregistered hostnames", async () => {
  for (const host of ["localhost", "other.trycloudflare.com"]) {
    await new Promise((resolve) =>
      dns.lookup(host, {}, (error) => {
        assert.equal(error, missing);
        resolve();
      }),
    );
  }
  assert.deepEqual(resolved, []);
});
test("supports Node all-address lookup for the registered tunnel", async () => {
  await new Promise((resolve) =>
    dns.lookup("fixture.trycloudflare.com", { all: true }, (error, values) => {
      assert.equal(error, null);
      assert.deepEqual(values, [{ address: "192.0.2.1", family: 4 }]);
      resolve();
    }),
  );
});
test("refuses adding arbitrary hostnames", () => assert.throws(() => allow("example.com")));
