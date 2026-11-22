const assert = require("node:assert/strict");
const test = require("node:test");

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GITHUB_APP_ID = "1";
process.env.GITHUB_APP_PRIVATE_KEY = require("node:crypto")
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });
const axios = require("axios");
const prisma = require("../dist/db").default;
const { githubSourceControl } = require("../dist/integrations/githubApp");
const {
  bindSourceControl,
  getSourceControlAdapter,
  registerSourceControlAdapter,
  sourceControlFor,
} = require("../dist/integrations/sourceControl");
const { sealIntegrationConfig } = require("../dist/services/integrationConfigService");
const { gitRemoteEnv } = require("../dist/services/workspaceService");

const repository = (overrides = {}) => ({
  id: "repo-1",
  provider: "GITHUB",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
  githubInstallationId: null,
  connectionId: null,
  ...overrides,
});

// A second host, registered the way a real one would be: only an adapter.
const calls = [];
const fakeHost = {
  type: "TEST_HOST",
  configSchema: { safeParse: () => ({ success: true }) },
  branchHead: async (target, branch) => (calls.push(["branchHead", target, branch]), "abc123"),
  gitToken: async (target) => `token-for-${target.config.user}`,
  gitRemote: ({ config, repository: repo }) => ({ url: `${config.baseUrl}/${repo.owner}/${repo.name}.git`, username: "oauth2" }),
  findOpenPullRequest: async () => undefined,
  createDraftPullRequest: async () => ({ number: 7, url: "https://git.example.com/acme/widgets/-/merge_requests/7" }),
};
registerSourceControlAdapter(fakeHost);

test("a repository is served by the adapter registered for its provider", () => {
  assert.equal(getSourceControlAdapter("GITHUB"), githubSourceControl);
  assert.equal(getSourceControlAdapter("TEST_HOST"), fakeHost);
  assert.equal(getSourceControlAdapter("NOWHERE"), undefined);
});

test("a repository whose provider has no adapter fails without retrying", () => {
  assert.throws(() => bindSourceControl(repository({ provider: "NOWHERE" }), {}), {
    name: "NonRetryableError",
    message: /No source-control adapter for provider NOWHERE/,
  });
});

test("a new host's adapter receives the repository and its connection's decrypted config", async (t) => {
  const connection = { id: "conn-1", encryptedConfig: sealIntegrationConfig({ baseUrl: "https://git.example.com", user: "bot" }) };
  // Prisma's model delegates are proxies, so the delegate is replaced as ingestion.test.js does.
  const real = prisma.integrationConnection;
  t.after(() => { prisma.integrationConnection = real; });
  prisma.integrationConnection = {
    findUniqueOrThrow: async ({ where }) => (assert.equal(where.id, "conn-1"), connection),
  };
  const sourceControl = await sourceControlFor(repository({ provider: "TEST_HOST", connectionId: "conn-1" }));
  assert.equal(await sourceControl.branchHead("main"), "abc123");
  assert.equal(calls.at(-1)[1].repository.owner, "acme");
  assert.equal(await sourceControl.gitToken(), "token-for-bot");
  assert.deepEqual(sourceControl.gitRemote(), { url: "https://git.example.com/acme/widgets.git", username: "oauth2" });
});

test("GitHub takes its installation from the connection before the older repository column", async (t) => {
  const urls = [];
  t.mock.method(axios, "post", async (url) => (urls.push(url), { data: { token: "t" } }));
  await bindSourceControl(repository({ githubInstallationId: "old" }), { installationId: "new" }).gitToken();
  await bindSourceControl(repository({ githubInstallationId: "old" }), {}).gitToken();
  assert.deepEqual(urls, [
    "https://api.github.com/app/installations/new/access_tokens",
    "https://api.github.com/app/installations/old/access_tokens",
  ]);
  await assert.rejects(bindSourceControl(repository(), {}).gitToken(), { name: "NonRetryableError", message: /no GitHub installation id/ });
  assert.deepEqual(bindSourceControl(repository(), {}).gitRemote(), { url: "https://github.com/acme/widgets.git", username: "x-access-token" });
});

test("a GitHub connection's config must name an installation", () => {
  assert.equal(githubSourceControl.configSchema.safeParse({ installationId: "123" }).success, true);
  assert.equal(githubSourceControl.configSchema.safeParse({}).success, false);
});

test("git sends the token only to the remote's own origin, over plain https", () => {
  assert.deepEqual(gitRemoteEnv({ url: "https://gitlab.example.com:8443/group/sub/widgets.git", username: "oauth2" }), {
    GIT_REMOTE: "https://gitlab.example.com:8443/group/sub/widgets.git",
    GIT_ORIGIN: "https://gitlab.example.com:8443",
    GIT_USERNAME: "oauth2",
  });
  for (const url of ["http://github.com/a/b.git", "ssh://git@github.com/a/b.git", "file:///repo", "https://user:pw@github.com/a/b.git", "https://github.com/a/b.git?x=1", "not a url"])
    assert.throws(() => gitRemoteEnv({ url, username: "x-access-token" }), /Git remote/, url);
  assert.throws(() => gitRemoteEnv({ url: "https://github.com/a/b.git", username: "x$(id)" }), /Unsafe git user name/);
});
