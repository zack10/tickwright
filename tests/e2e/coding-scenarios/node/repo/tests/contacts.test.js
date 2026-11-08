const assert = require("node:assert/strict");
const test = require("node:test");
const { importContacts } = require("../src/contacts");

test("imports contacts and normalises emails", () => {
  const contacts = importContacts("name,email,company\nAda Lovelace, ADA@Example.com ,Analytical\n");
  assert.deepEqual(contacts, [{ name: "Ada Lovelace", email: "ada@example.com", company: "Analytical" }]);
});

test("skips rows without an email", () => {
  assert.deepEqual(importContacts("name,email,company\nNobody,,Acme\n"), []);
});
