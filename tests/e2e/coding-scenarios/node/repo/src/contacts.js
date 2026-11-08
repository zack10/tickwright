const { parseCsv } = require("./csv");

/**
 * Imports contacts from a spreadsheet export (CSV with name, email and
 * company columns). Rows without a valid-looking email are skipped.
 */
function importContacts(text) {
  return parseCsv(text)
    .map((row) => ({
      name: (row.name ?? "").trim(),
      email: (row.email ?? "").trim().toLowerCase(),
      company: (row.company ?? "").trim(),
    }))
    .filter((contact) => contact.email.includes("@"));
}

module.exports = { importContacts };
