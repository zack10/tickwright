const assert = require("node:assert/strict");
const test = require("node:test");
const { lineTotal, orderTotal } = require("../src/pricing");

test("line total is price times quantity", () => {
  assert.equal(lineTotal({ unitPrice: 2.5, quantity: 4 }), 10);
});

test("order total with whole amounts", () => {
  assert.equal(orderTotal([{ unitPrice: 10, quantity: 2 }]), 20);
  assert.equal(orderTotal([{ unitPrice: 10, quantity: 2 }], { taxRate: 0.1 }), 22);
  assert.equal(orderTotal([{ unitPrice: 50, quantity: 2 }], { discountPercent: 10 }), 90);
});
