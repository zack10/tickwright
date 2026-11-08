"""Money amounts as integer cents."""

from decimal import ROUND_HALF_UP, Decimal


def to_cents(amount):
    """Converts an amount such as "19.99" or 3 to cents, rounding half up."""
    return int((Decimal(str(amount)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def format_cents(cents):
    """Formats cents as an amount with two decimals, e.g. -5 as "-0.05"."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
