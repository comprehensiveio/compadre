/**
 * GitHub usernames are 1-39 alphanumeric characters or single hyphens, never
 * leading, trailing, or doubled. A pasted profile URL or leading `@` is
 * tolerated so people can copy from GitHub without trimming by hand.
 */
const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/iu;

export function normalizeGithubLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let login = value.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)/iu.exec(login);
  if (url) login = url[1] ?? "";
  login = login.replace(/^@/u, "");
  return GITHUB_LOGIN_PATTERN.test(login) ? login : null;
}

/** GitHub links this address to the account by username, no verified email needed. */
export function githubNoreplyEmail(login: string): string {
  return `${login}@users.noreply.github.com`;
}
