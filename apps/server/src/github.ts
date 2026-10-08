import { FakeGitHub, GitHubAppClient, type GitHubClient } from "@hbe/github";
import type { Settings } from "@hbe/settings";

/** The real GitHub App client, or (local only) an in-memory GitHub. */
export function createGitHubClient(settings: Settings): GitHubClient {
  const { env } = settings;
  if (env.GITHUB_FAKE) return new FakeGitHub({ permissive: true });
  return new GitHubAppClient({
    appId: env.GITHUB_APP_ID!,
    privateKey: Buffer.from(env.GITHUB_APP_PRIVATE_KEY_BASE64!, "base64").toString("utf8"),
    apiUrl: env.GITHUB_API_URL,
  });
}
