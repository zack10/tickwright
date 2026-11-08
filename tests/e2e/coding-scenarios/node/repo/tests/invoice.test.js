const assert = require("node:assert/strict");
const test = require("node:test");
const { formatMoney } = require("../src/money");
const { renderInvoice } = require("../src/invoice");

test("formats cents as dollars", () => {
  assert.equal(formatMoney(1250), "$12.50");
  assert.equal(formatMoney(5), "$0.05");
});

test("renders a USD invoice", () => {
  const text = renderInvoice({
    currency: "USD",
    lines: [
      { description: "Widget", amountCents: 1250 },
      { description: "Shipping", amountCents: 500 },
    ],
  });
  assert.equal(text, "Widget: $12.50\nShipping: $5.00\nTotal: $17.50");
});
