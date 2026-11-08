"""Invoice totals."""

from decimal import ROUND_HALF_UP, Decimal

from .money import to_cents


def line_cents(price, quantity):
    """One invoice line in cents."""
    return to_cents(price) * quantity


def invoice_total_cents(lines, discount_percent=0):
    """Total of (price, quantity) lines in cents. A percentage discount applies
    once, to the total, rounded half up to the cent."""
    subtotal = sum(line_cents(price, quantity) for price, quantity in lines)
    discount = (Decimal(subtotal) * Decimal(str(discount_percent)) / 100).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    )
    return subtotal - int(discount)
