// Process-local fallback for quick-tunnel DNS on hosts where OS lookup returns
// ENOTFOUND while DNS resolution succeeds. Never changes system DNS or local names.
const dns = require("node:dns");
const hosts = new Set();
function allow(host) {
  if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(host))
    throw new Error("Expected an E2E quick-tunnel hostname");
  hosts.add(host);
}
for (const host of (process.env.COMPADRE_E2E_DNS_HOSTS || "").split(",").filter(Boolean))
  allow(host);
const original = dns.lookup;
dns.lookup = function lookup(host, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return original(host, options, (error, address, family) => {
    if (!error || error.code !== "ENOTFOUND" || !hosts.has(host))
      return callback(error, address, family);
    dns.resolve4(host, (fallbackError, addresses) => {
      if (fallbackError || !addresses?.length) return callback(error);
      if (options?.all)
        return callback(
          null,
          addresses.map((address) => ({ address, family: 4 })),
        );
      callback(null, addresses[0], 4);
    });
  });
};
module.exports = { allow };
