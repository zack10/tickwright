const assert = require("node:assert/strict");
const test = require("node:test");

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const { hashSnapshot } = require("../dist/services/executionService");
const {
  openIntegrationConfig,
  redactIntegration,
  sealIntegrationConfig,
} = require("../dist/services/integrationConfigService");

test("integration credentials are encrypted and redacted", () => {
  const sealed = sealIntegrationConfig({ token: "secret", boardId: "board" });
  assert.equal(JSON.stringify(sealed).includes("secret"), false);
  assert.deepEqual(openIntegrationConfig(sealed), {
    token: "secret",
    boardId: "board",
  });
  const redacted = redactIntegration({ id: "1", encryptedConfig: sealed });
  assert.deepEqual(redacted, { id: "1", config: { configured: true } });
});

test("approval snapshot hashes are deterministic and content-bound", () => {
  assert.equal(hashSnapshot({ diff: "a" }), hashSnapshot({ diff: "a" }));
  assert.notEqual(hashSnapshot({ diff: "a" }), hashSnapshot({ diff: "b" }));
});

test("the agent's and the reviewer's API keys are encrypted and redacted", () => {
  const { protectAgentConfig, redactAgent } = require("../dist/utils/agentConfig");
  const { decrypt } = require("../dist/utils/crypto");
  const config = protectAgentConfig({
    apiKey: "agent-key",
    reviewer: { provider: "openai", model: "gpt-5", apiKey: "reviewer-key" },
  });
  assert.equal(/agent-key|reviewer-key/.test(JSON.stringify(config)), false);
  assert.equal(decrypt(config.reviewer.apiKey), "reviewer-key");
  assert.deepEqual(redactAgent({ id: "1", config }).config, { reviewer: { provider: "openai", model: "gpt-5" } });

  const perCall = protectAgentConfig({
    models: { triage: { provider: "openai", model: "gpt-5-nano", apiKey: "triage-key" }, plan: { provider: "openai", model: "gpt-5-nano" } },
  });
  assert.equal(JSON.stringify(perCall).includes("triage-key"), false);
  assert.equal(decrypt(perCall.models.triage.apiKey), "triage-key");
  assert.deepEqual(redactAgent({ id: "1", config: perCall }).config, {
    models: { triage: { provider: "openai", model: "gpt-5-nano" }, plan: { provider: "openai", model: "gpt-5-nano" } },
  });
});
