/** URL-friendly slug: lowercase ASCII letters and digits separated by single dashes. */
function slugify(input) {
  if (typeof input !== "string") throw new TypeError("slugify expects a string");
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Shortens text to `max` characters, ending with an ellipsis when cut. */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

module.exports = { slugify, truncate };
