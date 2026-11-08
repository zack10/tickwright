const assert = require("node:assert/strict");
const test = require("node:test");
const { formatMoney } = require("../src/money");
const { renderInvoice } = require("../src/invoice");

test("formatMoney uses the currency's symbol", () => {
  assert.equal(formatMoney(1250, "EUR"), "€12.50");
  assert.equal(formatMoney(5, "GBP"), "£0.05");
  assert.equal(formatMoney(1250, "USD"), "$12.50");
  assert.equal(formatMoney(1250), "$12.50");
});

test("invoices use their own currency on every line and the total", () => {
  const lines = [
    { description: "Widget", amountCents: 1250 },
    { description: "Shipping", amountCents: 500 },
  ];
  assert.equal(renderInvoice({ currency: "EUR", lines }), "Widget: €12.50\nShipping: €5.00\nTotal: €17.50");
  assert.equal(renderInvoice({ currency: "GBP", lines }), "Widget: £12.50\nShipping: £5.00\nTotal: £17.50");
});
