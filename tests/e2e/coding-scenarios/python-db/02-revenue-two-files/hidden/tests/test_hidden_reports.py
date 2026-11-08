from datetime import datetime
from decimal import Decimal

from shop.orders import add_customer, add_order
from shop.reports import revenue_by_customer
from tests.support import DatabaseTest


class HiddenReportsTest(DatabaseTest):
    def test_the_ticket_example(self):
        ana = add_customer(self.conn, "Ana")
        add_order(self.conn, ana, "10.50", datetime(2026, 3, 1, 12, 0))
        add_order(self.conn, ana, "4.25", datetime(2026, 3, 2, 12, 0), status="shipped")
        add_order(self.conn, ana, "99.00", datetime(2026, 3, 3, 12, 0), status="cancelled")
        self.assertEqual(revenue_by_customer(self.conn), {"Ana": Decimal("14.75")})

    def test_only_cancelled_orders_mean_no_revenue(self):
        ben = add_customer(self.conn, "Ben")
        add_order(self.conn, ben, "20.00", datetime(2026, 3, 1, 12, 0), status="cancelled")
        self.assertEqual(revenue_by_customer(self.conn), {})
