"""Stock levels and reordering."""


def reorder_list(stock, threshold):
    """SKUs whose quantity is below the reorder threshold, sorted."""
    return sorted(sku for sku, quantity in stock.items() if quantity < threshold)


def reserve(stock, sku, quantity):
    """Stock after reserving `quantity` of `sku`; refuses more than is available."""
    available = stock.get(sku, 0)
    if quantity > available:
        raise ValueError(f"only {available} of {sku} in stock")
    return {**stock, sku: available - quantity}
