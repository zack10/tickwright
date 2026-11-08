const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyProposal,
  discoverEnvironment,
  discoveryFiles,
  hashProposal,
  parseDiscoveryReply,
} = require("../dist/services/toolchain/discovery");
const { resolveToolchain } = require("../dist/services/toolchain");
const { describeVerification } = require("../dist/services/workspaceService");

const reply = (fields) => JSON.stringify({ works: false, rationale: "from the CI file", ...fields });
const PROPOSAL = { image: "example/runtime:1.2", setup: "make deps", checks: { test: "make test" }, language: "Example" };

/** A model that replies with the scripted texts in order and records what it was shown. */
const scriptedModel = (replies) => {
  const shown = [];
  return {
    shown,
    ask: async (lastAttempt) => {
      shown.push(lastAttempt);
      return replies[Math.min(shown.length - 1, replies.length - 1)];
    },
  };
};

/** Proofs in order; records each proposal it was asked to prove. */
const scriptedProofs = (proofs) => {
  const proved = [];
  return {
    proved,
    prove: async (proposal) => {
      proved.push(proposal);
      return { image: `snapshot-${proved.length}`, setupOutputs: [], ...proofs[proved.length - 1] };
    },
  };
};

const passing = { baseline: [{ check: "test", passed: true, output: "ok" }] };

test("a reply becomes a proposal of shell commands that passes the configuration rules", () => {
  const parsed = parseDiscoveryReply("```json\n" + reply(PROPOSAL) + "\n```", {});
  assert.equal(parsed.works, false);
  assert.deepEqual(parsed.proposal, {
    image: "example/runtime:1.2",
    setup: ["sh", "-c", "make deps"],
    checks: { test: ["sh", "-c", "make test"] },
    language: "Example",
  });
  assert.equal(parsed.rationale, "from the CI file");

  assert.deepEqual(parseDiscoveryReply(reply({ ...PROPOSAL, setup: null }), {}).proposal.setup, null);
  assert.match(parseDiscoveryReply(reply({ ...PROPOSAL, image: "--privileged" }), {}).error, /invalid image reference/);
  assert.match(parseDiscoveryReply(reply({ ...PROPOSAL, checks: { "bad name": "x" } }), {}).error, /checks/);
  assert.match(parseDiscoveryReply(reply({ setup: "x" }), {}).error, /No image/);
  assert.match(parseDiscoveryReply("I think it needs make", {}).error, /not JSON/);
  assert.deepEqual(parseDiscoveryReply('{ "works": true }', {}), { works: true });
});

test("what the project fixes is not proposed", () => {
  const parsed = parseDiscoveryReply(reply(PROPOSAL), { image: "project/image:3", setup: ["sh", "-c", "own setup"] });
  assert.deepEqual(parsed.proposal, { checks: { test: ["sh", "-c", "make test"] }, language: "Example" });

  const { toolchain } = resolveToolchain(() => undefined, { toolchain: { image: "project/image:3" } });
  const applied = applyProposal(toolchain, parsed.proposal);
  assert.equal(applied.image, "project/image:3");
  assert.deepEqual(applied.checks, { test: ["sh", "-c", "make test"] });
  assert.equal(applied.language, "Example");
});

test("a proposal that works the first time is proved once", async () => {
  const model = scriptedModel([reply(PROPOSAL)]);
  const proofs = scriptedProofs([passing]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.equal(result.fromStored, false);
  assert.equal(result.proof.image, "snapshot-1");
  assert.deepEqual(model.shown, ["None."]);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["works"]);
});

test("a failed setup goes back to the model with its output, and the revision is proved", async () => {
  const model = scriptedModel([reply(PROPOSAL), reply({ ...PROPOSAL, image: "example/runtime:2.0" })]);
  const proofs = scriptedProofs([{ setupError: "make: deps: requires runtime >= 2", baseline: [] }, passing]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.equal(result.proposal.image, "example/runtime:2.0");
  assert.equal(result.proof.image, "snapshot-2");
  assert.match(model.shown[1], /Image: example\/runtime:1\.2\nSetup: make deps\nChecks:\n- test: make test/);
  assert.match(model.shown[1], /Setup failed:\nmake: deps: requires runtime >= 2/);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["setup_failed", "works"]);
});

test("a long setup failure keeps how it failed in the recorded attempt, not only the end of its output", async () => {
  const output = `docker run failed (killed by SIGTERM)\nstderr:\n(empty)\nstdout:\n${"Compiling...\n".repeat(500)}`;
  const model = scriptedModel([reply(PROPOSAL)]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 1 }, { ...model, ...scriptedProofs([{ setupError: output, baseline: [] }]) });
  assert.match(result.attempts[0].detail, /^docker run failed \(killed by SIGTERM\)\n\.\.\.\n/);
  assert.ok(result.attempts[0].detail.endsWith("Compiling...\n"));
});

test("proposed variables reach setup and every check, on top of the project's own", async () => {
  const parsed = parseDiscoveryReply(reply({ ...PROPOSAL, env: { RUNTIME_HOME: "/opt/runtime-2" } }), {});
  assert.deepEqual(parsed.proposal.env, { RUNTIME_HOME: "/opt/runtime-2" });
  assert.equal(parseDiscoveryReply(reply({ ...PROPOSAL, env: {} }), {}).proposal.env, undefined);
  assert.ok(parseDiscoveryReply(reply({ ...PROPOSAL, env: { "BAD-NAME": "x" } }), {}).error, "names follow the configuration rules");

  const { toolchain } = resolveToolchain(() => undefined, { toolchain: { env: { CI: "true" } } });
  assert.deepEqual(applyProposal(toolchain, parsed.proposal).env, { CI: "true", RUNTIME_HOME: "/opt/runtime-2" });

  const model = scriptedModel([reply(PROPOSAL), reply({ ...PROPOSAL, env: { RUNTIME_HOME: "/opt/runtime-2" } })]);
  const proofs = scriptedProofs([{ setupError: "runtime 1 is too old", baseline: [] }, passing]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.deepEqual(result.proposal.env, { RUNTIME_HOME: "/opt/runtime-2" }, "a changed env is a new proposal");
  assert.equal(proofs.proved.length, 2);
});

test("a proposal that already failed is not proved again", async () => {
  const fixed = { image: "default/universal:2" };
  const revised = { ...PROPOSAL, setup: "install runtime 2 && make deps" };
  const model = scriptedModel([reply(PROPOSAL), reply(PROPOSAL), reply(revised)]);
  const proofs = scriptedProofs([{ setupError: "make: deps: requires runtime >= 2", baseline: [] }, passing]);
  const result = await discoverEnvironment({ fixed, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.equal(proofs.proved.length, 2);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["setup_failed", "invalid", "works"]);
  assert.match(model.shown[2], /requires runtime >= 2\n\nYou then proposed exactly this environment again/);
  assert.equal(result.proposal.image, undefined, "the given image is never proposed");
});

test("a failing check is the project's own failure when the model says the environment works", async () => {
  const model = scriptedModel([reply(PROPOSAL), '{ "works": true }']);
  const failingTest = { baseline: [{ check: "test", passed: false, output: "1 failed: expected 3, got 4" }] };
  const proofs = scriptedProofs([failingTest]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.equal(proofs.proved.length, 1, "not set up again");
  assert.match(model.shown[1], /- test: failed\n1 failed: expected 3, got 4/);
});

test("a check that cannot run is revised", async () => {
  const model = scriptedModel([reply(PROPOSAL), reply({ ...PROPOSAL, checks: { test: "make check" } })]);
  const proofs = scriptedProofs([{ baseline: [{ check: "test", passed: false, output: "make: *** No rule to make target 'test'" }] }, passing]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.deepEqual(result.proposal.checks, { test: ["sh", "-c", "make check"] });
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["checks_failed", "works"]);
});

test("a stored proposal is proved again without asking the model", async () => {
  const stored = parseDiscoveryReply(reply(PROPOSAL), {}).proposal;
  const model = scriptedModel([reply(PROPOSAL)]);
  const proofs = scriptedProofs([passing]);
  const result = await discoverEnvironment({ fixed: {}, stored, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, true);
  assert.equal(result.fromStored, true);
  assert.deepEqual(model.shown, []);
  assert.equal(hashProposal(result.proposal), hashProposal(stored), "unchanged, so not stored again");

  // The project has since fixed its image: the stored one is no longer used.
  const later = scriptedProofs([passing]);
  await discoverEnvironment({ fixed: { image: "project/image:3" }, stored, maxAttempts: 3 }, { ...model, ...later });
  assert.equal(later.proved[0].image, undefined);
});

test("discovery gives up after its attempts, and unusable replies count", async () => {
  const model = scriptedModel(["not json", '{ "works": true }', reply(PROPOSAL)]);
  const proofs = scriptedProofs([{ setupError: "no", baseline: [] }]);
  const result = await discoverEnvironment({ fixed: {}, maxAttempts: 3 }, { ...model, ...proofs });
  assert.equal(result.proven, false);
  assert.equal(result.proposal, undefined);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ["invalid", "invalid", "setup_failed"]);
  assert.match(model.shown[1], /could not be used: The reply was not JSON/);
  assert.match(model.shown[2], /Nothing has been tried yet/);
});

test("discovery reads instruction and CI files first, then root and subproject files, never deeper", () => {
  const files = {
    "README.md": "Run make test.",
    ".github/workflows/ci.yml": "run: make test",
    "build.file": "deps",
    "lock.file": "x".repeat(7000),
    "web/manifest": "web deps",
    "src/deep/code.src": "SOURCE BODY",
    "logo.png": "PNG\0data",
  };
  const text = discoveryFiles((file) => files[file], Object.keys(files));
  assert.match(text, /^File tree \(tracked files\):\n\.github\/workflows\/ci\.yml\n/);
  assert.match(text, /src\/deep\/code\.src/, "every file is in the tree");
  assert.doesNotMatch(text, /SOURCE BODY/, "contents stop one level down");
  assert.doesNotMatch(text, /PNG/);
  const order = ["--- .github/workflows/ci.yml", "--- README.md", "--- build.file", "--- lock.file", "--- web/manifest"].map((h) => text.indexOf(h));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(text, /\[truncated: 7000 characters\]/);
});

test("the PR body says the checks were proposed by the agent and how to approve them", () => {
  const text = describeVerification({
    checksRun: 1,
    results: [{ script: "test", passed: true, output: "" }],
    environmentProposal: { repositoryId: "repo-1", hash: "a".repeat(64), checks: { test: ["sh", "-c", "make test"] } },
  });
  assert.match(text, /^Checks passed: test\./);
  assert.match(text, /proposed by the agent .* not approved yet/);
  assert.match(text, /- test: `make test`/);
  assert.match(text, /POST \/api\/repositories\/repo-1\/environment\/approve` with `\{ "proposalHash": "a{64}" \}`/);
  assert.doesNotMatch(describeVerification({ checksRun: 1, results: [] }), /proposed/);
});
