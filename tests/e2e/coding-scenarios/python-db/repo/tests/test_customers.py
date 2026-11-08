from datetime import datetime

from shop.customers import order_counts
from shop.orders import add_customer, add_order
from tests.support import DatabaseTest


class CustomersTest(DatabaseTest):
    def test_order_counts(self):
        ana = add_customer(self.conn, "Ana")
        ben = add_customer(self.conn, "Ben")
        add_order(self.conn, ana, "10.00", datetime(2026, 3, 1, 12, 0))
        add_order(self.conn, ben, "20.00", datetime(2026, 3, 1, 13, 0))
        add_order(self.conn, ben, "30.00", datetime(2026, 3, 2, 12, 0))
        self.assertEqual(order_counts(self.conn), {"Ana": 1, "Ben": 2})
