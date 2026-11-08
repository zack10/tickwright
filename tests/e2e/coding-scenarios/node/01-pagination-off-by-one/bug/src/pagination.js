/**
 * Returns one page of `items`. Pages are numbered from 1.
 */
function paginate(items, page, pageSize) {
  if (!Number.isInteger(page) || page < 1)
    throw new RangeError("page must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw new RangeError("pageSize must be a positive integer");

  const start = page * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages: Math.ceil(items.length / pageSize),
    hasNext: start + pageSize < items.length,
  };
}

module.exports = { paginate };
