"""Revenue reports."""

from shop.statuses import REVENUE_STATUSES


def revenue_by_customer(conn):
    """Each customer's revenue, {name: Decimal}, for the customers who have any."""
    rows = conn.execute(
        "SELECT c.name, ROUND(SUM(o.total)) FROM customers c JOIN orders o ON o.customer_id = c.id"
        " WHERE o.status = ANY(%s) GROUP BY c.name ORDER BY c.name",
        (list(REVENUE_STATUSES),),
    ).fetchall()
    return dict(rows)
