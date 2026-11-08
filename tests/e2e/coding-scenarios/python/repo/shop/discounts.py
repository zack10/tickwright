"""Order discounts."""

# (minimum order total, rate); a tier applies from its minimum, inclusive.
TIERS = [(500, 0.20), (100, 0.10)]


def discount_rate(total):
    """The discount rate for an order total."""
    for minimum, rate in TIERS:
        if total >= minimum:
            return rate
    return 0.0


def discounted_total(total):
    """The order total after its discount, rounded to the cent."""
    return round(total * (1 - discount_rate(total)), 2)
