/** Rounds a currency amount to whole cents. */
function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function lineTotal(line) {
  return line.unitPrice * line.quantity;
}

/**
 * Total for an order: subtotal, minus a percentage discount, plus tax.
 * `taxRate` is a fraction (0.2 = 20%), `discountPercent` a percentage.
 */
function orderTotal(lines, { taxRate = 0, discountPercent = 0 } = {}) {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const discounted = subtotal * (1 - discountPercent / 100);
  return roundCents(discounted * (1 + taxRate));
}

module.exports = { lineTotal, orderTotal, roundCents };
