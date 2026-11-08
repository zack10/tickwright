const { formatMoney } = require("./money");

/** Plain-text invoice: one line per item, then the total. */
function renderInvoice(invoice) {
  const lines = invoice.lines.map(
    (line) => `${line.description}: ${formatMoney(line.amountCents)}`,
  );
  const totalCents = invoice.lines.reduce((sum, line) => sum + line.amountCents, 0);
  return [...lines, `Total: ${formatMoney(totalCents)}`].join("\n");
}

module.exports = { renderInvoice };
