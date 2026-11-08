"""Customer statistics."""


def order_counts(conn):
    """How many orders each customer has placed, {name: count}."""
    rows = conn.execute(
        "SELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id"
        " GROUP BY c.name ORDER BY c.name"
    ).fetchall()
    return dict(rows)
