const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { errorHandler } = require("../dist/middleware/errorHandler");

function responseRecorder(events) {
  const response = {
    status(statusCode) {
      events.push(["status", statusCode]);
      return response;
    },
    json(body) {
      events.push(["json", body]);
      return response;
    },
  };
  return response;
}

function knownError(code, meta) {
  return new Prisma.PrismaClientKnownRequestError("database secret", {
    code,
    clientVersion: "test",
    meta,
  });
}

function invoke(error) {
  const events = [];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    errorHandler(error, {}, responseRecorder(events), () => {});
  } finally {
    console.error = originalError;
  }
  return { events, logs };
}

test("logs a sanitized Prisma code before returning the generic database error", () => {
  const result = invoke(knownError("P2028"));

  assert.deepEqual(result.events, [
    ["status", 500],
    [
      "json",
      { error: { code: "DATABASE_ERROR", message: "A database error occurred" } },
    ],
  ]);
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /P2028/);
  assert.doesNotMatch(result.logs[0], /database secret/);
});

test("keeps known Prisma errors with specific responses unlogged", () => {
  const cases = [
    {
      error: knownError("P2002", { target: ["email"] }),
      events: [
        ["status", 409],
        ["json", { error: { code: "CONFLICT", message: "Unique constraint violation on: email" } }],
      ],
    },
    {
      error: knownError("P2003"),
      events: [
        ["status", 400],
        ["json", { error: { code: "FOREIGN_KEY_ERROR", message: "Related record not found" } }],
      ],
    },
    {
      error: knownError("P2025"),
      events: [
        ["status", 404],
        ["json", { error: { code: "NOT_FOUND", message: "Record not found" } }],
      ],
    },
  ];

  for (const { error, events } of cases) {
    const result = invoke(error);
    assert.deepEqual(result.events, events);
    assert.deepEqual(result.logs, []);
  }
});

test("keeps logging ordinary errors and returning the internal error response", () => {
  const result = invoke(new Error("ordinary failure"));

  assert.deepEqual(result.events, [
    ["status", 500],
    [
      "json",
      { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    ],
  ]);
  assert.equal(result.logs.length, 1);
  assert.match(result.logs[0], /^Unhandled error: Error: ordinary failure$/);
});
