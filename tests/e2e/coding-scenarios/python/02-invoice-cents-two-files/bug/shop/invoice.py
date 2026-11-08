"""Invoice totals."""

from .money import to_cents


def line_cents(price, quantity):
    """One invoice line in cents."""
    return to_cents(price) * quantity


def invoice_total_cents(lines, discount_percent=0):
    """Total of (price, quantity) lines in cents, with a percentage discount."""
    total = 0
    for price, quantity in lines:
        cents = line_cents(price, quantity)
        total += cents - int(cents * discount_percent / 100)
    return total
