const assert = require("node:assert/strict");
const test = require("node:test");
const { importContacts } = require("../src/contacts");

const columns = "name,email,company";

test("names containing a comma are imported", () => {
  const contacts = importContacts(`${columns}\n"Smith, John",john@example.com,Acme\nAda,ada@example.com,Analytical\n`);
  assert.deepEqual(contacts, [
    { name: "Smith, John", email: "john@example.com", company: "Acme" },
    { name: "Ada", email: "ada@example.com", company: "Analytical" },
  ]);
});

test("escaped quotes inside quoted names", () => {
  const contacts = importContacts(`${columns}\n"O""Brien, Pat",pat@example.com,"Shop, Inc."\n`);
  assert.deepEqual(contacts, [{ name: 'O"Brien, Pat', email: "pat@example.com", company: "Shop, Inc." }]);
});

test("Windows line endings", () => {
  const contacts = importContacts(`${columns}\r\n"Lee, Kim",kim@example.com,\r\n`);
  assert.deepEqual(contacts, [{ name: "Lee, Kim", email: "kim@example.com", company: "" }]);
});
