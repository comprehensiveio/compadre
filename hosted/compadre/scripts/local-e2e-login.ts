import pg from "pg";
import { createDatabase } from "../src/db/client.js";
import { UserDirectory } from "../src/services/user-directory.js";
import { AuthStore } from "../src/services/auth-store.js";

const url = new URL(process.env.COMPADRE_DURABILITY_DATABASE_URL ?? "");
const web = new URL(process.env.COMPADRE_E2E_WEB_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/compadre_e2e_test" || web.hostname !== "localhost") {
  throw new Error("E2E login only supports the disposable local E2E environment");
}
const name = process.argv[2];
if (name !== "alice" && name !== "bob") throw new Error("Choose alice or bob");
const pool = new pg.Pool({ connectionString: url.toString() });
try {
  const db = createDatabase(pool);
  const user = await new UserDirectory(db).upsertSlackIdentity({
    workspaceId: "T_E2E", slackUserId: name, displayName: `E2E ${name}`, realName: `E2E ${name}`,
  });
  const code = await new AuthStore(db).issueLoginGrant(user.id);
  const login = new URL("/auth/compadre/callback", web);
  login.searchParams.set("code", code);
  console.log(login.toString());
} finally {
  await pool.end();
}
