"""Customers and their orders."""

from datetime import timedelta


def add_customer(conn, name):
    """Adds a customer; returns its id."""
    return conn.execute("INSERT INTO customers (name) VALUES (%s) RETURNING id", (name,)).fetchone()[0]


def add_order(conn, customer_id, total, created_at, status="paid"):
    """Adds an order; returns its id."""
    return conn.execute(
        "INSERT INTO orders (customer_id, total, status, created_at) VALUES (%s, %s, %s, %s) RETURNING id",
        (customer_id, total, status, created_at),
    ).fetchone()[0]


def orders_between(conn, start, end):
    """Ids of the orders placed from day `start` to day `end`, both included, oldest first."""
    rows = conn.execute(
        "SELECT id FROM orders WHERE created_at >= %s AND created_at < %s ORDER BY created_at, id",
        (start, end + timedelta(days=1)),
    ).fetchall()
    return [row[0] for row in rows]
