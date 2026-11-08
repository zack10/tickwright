const assert = require("node:assert/strict");
const test = require("node:test");
const { countActiveUsers, getUserEmails } = require("../src/userService");

const repositoryOf = (users) => ({
  findById: async (id) => users.find((user) => user.id === id) ?? null,
});

test("collects emails of existing users", async () => {
  const repository = repositoryOf([
    { id: 1, email: "a@example.com", active: true },
    { id: 2, email: "b@example.com", active: false },
  ]);
  assert.deepEqual(await getUserEmails(repository, [1, 2, 3]), ["a@example.com", "b@example.com"]);
});

test("no ids means no active users", async () => {
  assert.equal(await countActiveUsers(repositoryOf([]), []), 0);
});
