const assert = require("node:assert/strict");
const test = require("node:test");
const { orderTotal } = require("../src/pricing");

test("rounds to the nearest cent, not down", () => {
  assert.equal(orderTotal([{ unitPrice: 6.67, quantity: 3 }]), 20.01);
  assert.equal(orderTotal([{ unitPrice: 19.99, quantity: 1 }], { taxRate: 0.0825 }), 21.64);
});

test("half a cent rounds up", () => {
  assert.equal(orderTotal([{ unitPrice: 0.125, quantity: 1 }]), 0.13);
});

test("discount and tax combine before rounding", () => {
  assert.equal(orderTotal([{ unitPrice: 33.33, quantity: 3 }], { discountPercent: 15, taxRate: 0.07 }), 90.94);
});

test("exact amounts are unchanged", () => {
  assert.equal(orderTotal([{ unitPrice: 10, quantity: 2 }], { taxRate: 0.1 }), 22);
});
