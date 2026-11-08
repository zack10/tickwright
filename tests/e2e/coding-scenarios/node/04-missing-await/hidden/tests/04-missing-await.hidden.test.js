const assert = require("node:assert/strict");
const test = require("node:test");
const { countActiveUsers } = require("../src/userService");

const repositoryOf = (users) => ({
  findById: (id) =>
    new Promise((resolve) => setTimeout(() => resolve(users.find((user) => user.id === id) ?? null), 1)),
});

test("counts only active users", async () => {
  const repository = repositoryOf([
    { id: 1, email: "a@example.com", active: true },
    { id: 2, email: "b@example.com", active: false },
    { id: 3, email: "c@example.com", active: true },
  ]);
  assert.equal(await countActiveUsers(repository, [1, 2, 3]), 2);
});

test("unknown ids are not counted", async () => {
  const repository = repositoryOf([{ id: 1, email: "a@example.com", active: true }]);
  assert.equal(await countActiveUsers(repository, [1, 7, 8]), 1);
});
