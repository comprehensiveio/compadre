const credentialKeys = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_AUTH_JSON_BASE64",
];

export function developmentCredentials(file, ambient = {}) {
  const result = Object.fromEntries(
    credentialKeys.flatMap((key) => {
      const value = file[key] ?? ambient[key];
      return value ? [[key, value]] : [];
    }),
  );
  for (const key of ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "ANTHROPIC_API_KEY"]) {
    if (!result[key]) throw new Error(`Missing ${key}`);
  }
  return result;
}

export function assertLocalStack(config) {
  for (const key of ["COMPADRE_DURABILITY_DATABASE_URL"]) {
    const url = new URL(config.controller[key]);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/compadre_e2e_test") {
      throw new Error("Expected disposable loopback E2E database");
    }
  }
  if (new URL(config.webUrl).hostname !== "localhost")
    throw new Error("Expected local E2E web URL");
  if (!/^compadre-e2e-[a-z0-9]+$/.test(config.controller.COMPADRE_T3_MODAL_APP))
    throw new Error("Expected isolated E2E Modal application");
}

export function issuedToken(stdout) {
  const token = stdout.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error("Central token issuance returned unexpected output; inspect its private log");
  return token;
}
