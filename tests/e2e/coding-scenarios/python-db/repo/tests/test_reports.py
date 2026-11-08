from datetime import datetime
from decimal import Decimal

from shop.orders import add_customer, add_order
from shop.reports import revenue_by_customer
from tests.support import DatabaseTest


class ReportsTest(DatabaseTest):
    def test_revenue_per_customer(self):
        ana = add_customer(self.conn, "Ana")
        ben = add_customer(self.conn, "Ben")
        add_order(self.conn, ana, "10.00", datetime(2026, 3, 1, 12, 0))
        add_order(self.conn, ana, "5.00", datetime(2026, 3, 2, 12, 0), status="shipped")
        add_order(self.conn, ben, "30.00", datetime(2026, 3, 2, 12, 0))
        self.assertEqual(revenue_by_customer(self.conn), {"Ana": Decimal("15"), "Ben": Decimal("30")})

    def test_customers_without_revenue_are_left_out(self):
        add_customer(self.conn, "Ana")
        self.assertEqual(revenue_by_customer(self.conn), {})
