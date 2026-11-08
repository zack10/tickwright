"""Money amounts as integer cents."""


def to_cents(amount):
    """Converts an amount such as "19.99" or 3 to cents."""
    return int(float(amount) * 100)


def format_cents(cents):
    """Formats cents as an amount with two decimals, e.g. -5 as "-0.05"."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
