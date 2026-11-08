from datetime import datetime

from shop.customers import order_counts
from shop.orders import add_customer, add_order
from tests.support import DatabaseTest


class HiddenCustomersTest(DatabaseTest):
    def test_customers_without_orders_count_zero(self):
        add_customer(self.conn, "Carla")
        ben = add_customer(self.conn, "Ben")
        add_order(self.conn, ben, "20.00", datetime(2026, 3, 1, 13, 0))
        add_order(self.conn, ben, "30.00", datetime(2026, 3, 2, 12, 0))
        self.assertEqual(order_counts(self.conn), {"Ben": 2, "Carla": 0})
