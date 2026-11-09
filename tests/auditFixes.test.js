const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Must be set before config is loaded.
delete process.env.API_AUTH_TOKEN;
delete process.env.AUTH_DISABLED;
process.env.NODE_ENV = "development";

const { writeActionsToRoot, parseFileActions } = require("../dist/utils/codeWriter");
const { reviewDiffSafety } = require("../dist/services/agentGraph/diffReview");
const { describeError, NonRetryableError } = require("../dist/utils/safeError");
const { validate } = require("../dist/middleware/validate");
const { authenticate } = require("../dist/middleware/authenticate");
const rabbitMQService = require("../dist/services/rabbitMQService").default;
const { z } = require("zod");
const { AxiosError } = require("axios");

const tempRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-audit-"));

// --- C1 / H3 / H9: code writer -------------------------------------------

test("H3: writes files containing backticks and template literals", () => {
  const root = tempRoot();
  try {
    const actions = [
      "FILE: src/greet.ts",
      "```ts",
      "export const greet = (name: string) => `hi ${name}`;",
      "const md = 'use `code` here';",
      "```",
    ].join("\n");
    assert.deepEqual(writeActionsToRoot(actions, root), ["src/greet.ts"]);
    assert.equal(
      fs.readFileSync(path.join(root, "src/greet.ts"), "utf8"),
      "export const greet = (name: string) => `hi ${name}`;\nconst md = 'use `code` here';\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("H3: parses CRLF output and multiple files", () => {
  const files = parseFileActions(
    "FILE: a.ts\r\n```ts\r\nexport const a = 1;\r\n```\r\n\r\nFILE: b.ts\r\n```\r\nexport const b = 2;\r\n```",
  );
  assert.deepEqual(files, [
    { filePath: "a.ts", code: "export const a = 1;\n" },
    { filePath: "b.ts", code: "export const b = 2;\n" },
  ]);
});

test("H3: malformed FILE blocks fail loudly instead of being skipped", () => {
  assert.throws(
    () => parseFileActions("FILE: a.ts\n```ts\nno closing fence"),
    /missing a closing fence/,
  );
  assert.throws(
    () => parseFileActions("FILE: a.ts\nexport const a = 1;"),
    /missing an opening fence/,
  );
});

test("C1: refuses to write git metadata (hooks, config)", () => {
  const root = tempRoot();
  try {
    for (const target of [".git/hooks/pre-commit", "src/../.git/config", ".GIT/config"]) {
      assert.throws(
        () => writeActionsToRoot(`FILE: ${target}\n\`\`\`sh\nevil\n\`\`\``, root),
        /git metadata|escapes/,
        target,
      );
    }
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("H9: refuses to write through symlinks that leave the root", (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    try {
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    assert.throws(
      () => writeActionsToRoot("FILE: linked/pwned.txt\n```\nx\n```", root),
      /symlink/,
    );
    assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("H9: a failing block prevents all writes (no partial output)", () => {
  const root = tempRoot();
  try {
    assert.throws(() =>
      writeActionsToRoot("FILE: ok.ts\n```\nok\n```\nFILE: bad.ts\n```\nunterminated", root),
    );
    assert.equal(fs.existsSync(path.join(root, "ok.ts")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- H5: secret detection --------------------------------------------------

test("H5: diff review catches GitHub app, fine-grained, and Anthropic tokens", () => {
  for (const secret of [
    "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "https://x-access-token:ghs_abcdefghijklmnop@github.com/o/r.git",
  ]) {
    const result = reviewDiffSafety(`+const value = "${secret}";`, ["src/a.ts"]);
    assert.equal(result.passed, false, secret);
  }
});

test("diff review rejects a repository setup secret's value, whatever it looks like", () => {
  const secret = "plain-looking-value-42";
  assert.equal(reviewDiffSafety(`+registry = ${secret}`, ["config.txt"]).passed, true, "no pattern matches it");
  assert.equal(reviewDiffSafety(`+registry = ${secret}`, ["config.txt"], [secret]).passed, false);
  assert.equal(reviewDiffSafety(`-registry = ${secret}`, ["config.txt"], [secret]).passed, true, "removing it is fine");
  assert.equal(reviewDiffSafety("+x = 1", ["a.txt"], ["1"]).passed, true, "short values are not matched");
});

// --- H6: log redaction ------------------------------------------------------

test("H6: describeError never includes query strings or headers", () => {
  const error = new AxiosError(
    "Request failed with status code 401",
    "ERR_BAD_REQUEST",
    {
      method: "get",
      url: "https://api.trello.com/1/boards/b/cards?key=SECRETKEY&token=SECRETTOKEN",
      headers: { Authorization: "Bearer SECRETBEARER" },
    },
    undefined,
    { status: 401, data: {}, headers: {}, statusText: "", config: {} },
  );
  const text = describeError(error);
  assert.match(text, /GET https:\/\/api\.trello\.com\/1\/boards\/b\/cards failed \(401\)/);
  assert.doesNotMatch(text, /SECRET/);
});

// --- H2: validation writes parsed values back -------------------------------

test("H2: validate strips unknown keys and applies defaults", () => {
  const schema = z.object({
    body: z.object({
      name: z.string(),
      branch: z.string().default("main"),
    }),
  });
  const req = { body: { name: "x", id: "attacker-chosen" }, params: {}, query: {}, headers: {} };
  let called = false;
  validate(schema)(req, {}, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.deepEqual(req.body, { name: "x", branch: "main" });
});

// --- H1: auth fails closed ------------------------------------------------

test("H1: requests are rejected when no token is configured and auth is not explicitly disabled", () => {
  let result;
  authenticate({ header: () => undefined }, {}, (error) => {
    result = error;
  });
  assert.equal(result?.statusCode, 401);
});

// --- C3: bounded retries and dead-lettering ---------------------------------

const fakeChannel = () => {
  const calls = { acks: 0, nacks: 0, sent: [] };
  return {
    calls,
    ack: () => calls.acks++,
    nack: () => calls.nacks++,
    sendToQueue: (queue, _content, options) => calls.sent.push({ queue, headers: options.headers }),
    waitForConfirms: async () => undefined,
  };
};
const delivery = (body, headers = {}) => ({
  content: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  properties: { headers, contentType: "application/json" },
});

test("C3: a failing handler is retried with a delay, never hot-requeued", async () => {
  const channel = fakeChannel();
  const subscription = {
    queueName: "q",
    routingKey: "k",
    maxAttempts: 3,
    onMessage: async () => {
      throw new Error("transient");
    },
  };
  await rabbitMQService.handleDelivery(channel, subscription, delivery({ a: 1 }));
  assert.equal(channel.calls.nacks, 0);
  assert.equal(channel.calls.acks, 1);
  assert.deepEqual(channel.calls.sent, [{ queue: "q.retry", headers: { "x-attempt": 2 } }]);
});

test("C3: exhausted retries are dead-lettered and trigger onExhausted once", async () => {
  const channel = fakeChannel();
  const exhausted = [];
  const subscription = {
    queueName: "q",
    routingKey: "k",
    maxAttempts: 3,
    onMessage: async () => {
      throw new Error("still failing");
    },
    onExhausted: async (message) => exhausted.push(message),
  };
  await rabbitMQService.handleDelivery(channel, subscription, delivery({ a: 1 }, { "x-attempt": 3 }));
  assert.equal(channel.calls.sent[0].queue, "q.dead");
  assert.deepEqual(exhausted, [{ a: 1 }]);
  assert.equal(channel.calls.acks, 1);
});

test("C3: non-retryable errors skip retries", async () => {
  const channel = fakeChannel();
  let exhaustedCount = 0;
  const subscription = {
    queueName: "q",
    routingKey: "k",
    maxAttempts: 5,
    onMessage: async () => {
      throw new NonRetryableError("policy violation");
    },
    onExhausted: async () => {
      exhaustedCount++;
    },
  };
  await rabbitMQService.handleDelivery(channel, subscription, delivery({ a: 1 }));
  assert.equal(channel.calls.sent[0].queue, "q.dead");
  assert.equal(exhaustedCount, 1);
});

test("C3: malformed messages are dead-lettered, not dropped or looped", async () => {
  const channel = fakeChannel();
  await rabbitMQService.handleDelivery(
    channel,
    { queueName: "q", routingKey: "k", onMessage: async () => undefined },
    delivery("{not json"),
  );
  assert.equal(channel.calls.sent[0].queue, "q.dead");
  assert.equal(channel.calls.acks, 1);
});

test("a channel the broker closes alone (consumer timeout) is reopened, not a crash", async () => {
  const { EventEmitter } = require("node:events");
  const channels = [];
  const model = {
    createConfirmChannel: async () => {
      const channel = Object.assign(new EventEmitter(), {
        consumed: [],
        assertExchange: async () => undefined,
        assertQueue: async () => undefined,
        bindQueue: async () => undefined,
        prefetch: async () => undefined,
        consume: async (queue) => channel.consumed.push(queue),
      });
      channels.push(channel);
      return channel;
    },
    close: async () => undefined,
  };
  const service = Object.create(Object.getPrototypeOf(rabbitMQService));
  Object.assign(service, { model, channel: null, closing: false, subscriptions: new Map() });
  service.subscriptions.set("execution_run", { queueName: "execution_run", routingKey: "execution.run", onMessage: async () => undefined });
  await service.openChannel();
  assert.deepEqual(channels[0].consumed, ["execution_run"]);

  // Without a listener this "error" would throw and stop the process.
  channels[0].emit("error", new Error("PRECONDITION_FAILED - delivery acknowledgement on channel 1 timed out"));
  channels[0].emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channels.length, 2, "a new channel is opened");
  assert.equal(service.channel, channels[1]);
  assert.deepEqual(channels[1].consumed, ["execution_run"], "subscriptions are restored on it");

  // Closing the service on purpose does not reopen anything.
  service.closing = true;
  channels[1].emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channels.length, 2);
});
