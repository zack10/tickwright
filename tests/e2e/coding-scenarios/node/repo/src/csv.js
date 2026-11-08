/**
 * Splits one CSV line into fields. Fields may be quoted; inside quotes a
 * comma is literal and "" is an escaped quote.
 */
function parseLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** Parses CSV text with a header row into an array of objects. */
function parseCsv(text) {
  const [header, ...rows] = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!header) return [];
  const columns = parseLine(header);
  return rows.map((row) => {
    const values = parseLine(row);
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
  });
}

module.exports = { parseCsv, parseLine };
