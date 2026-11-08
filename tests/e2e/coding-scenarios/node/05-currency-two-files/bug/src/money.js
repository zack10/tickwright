/** Formats an amount in cents, e.g. formatMoney(1250) === "$12.50". */
function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = { formatMoney };
