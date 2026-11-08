"""Customer statistics."""


def order_counts(conn):
    """How many orders each customer has placed, {name: count}."""
    rows = conn.execute(
        "SELECT c.name, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id"
        " GROUP BY c.name ORDER BY c.name"
    ).fetchall()
    return dict(rows)
