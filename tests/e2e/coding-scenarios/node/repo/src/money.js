const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

/** Formats an amount in cents, e.g. formatMoney(1250, "EUR") === "€12.50". */
function formatMoney(cents, currency = "USD") {
  const symbol = SYMBOLS[currency];
  if (!symbol) throw new RangeError(`Unsupported currency ${currency}`);
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

module.exports = { formatMoney };
