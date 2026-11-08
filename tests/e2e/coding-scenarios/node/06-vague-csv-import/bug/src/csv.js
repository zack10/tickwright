/** Splits one CSV line into fields, removing surrounding quotes. */
function parseLine(line) {
  return line.split(",").map((field) => field.replace(/^"|"$/g, ""));
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
