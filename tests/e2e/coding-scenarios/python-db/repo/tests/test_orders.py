from datetime import date, datetime

from shop.orders import add_customer, add_order, orders_between
from tests.support import DatabaseTest


class OrdersTest(DatabaseTest):
    def test_orders_in_the_range_oldest_first(self):
        ana = add_customer(self.conn, "Ana")
        later = add_order(self.conn, ana, "20.00", datetime(2026, 3, 3, 9, 0))
        earlier = add_order(self.conn, ana, "10.00", datetime(2026, 3, 2, 12, 0))
        add_order(self.conn, ana, "5.00", datetime(2026, 2, 27, 12, 0))
        self.assertEqual(orders_between(self.conn, date(2026, 3, 1), date(2026, 3, 5)), [earlier, later])

    def test_the_first_day_is_included(self):
        ana = add_customer(self.conn, "Ana")
        first = add_order(self.conn, ana, "10.00", datetime(2026, 3, 1, 0, 0))
        self.assertEqual(orders_between(self.conn, date(2026, 3, 1), date(2026, 3, 5)), [first])
