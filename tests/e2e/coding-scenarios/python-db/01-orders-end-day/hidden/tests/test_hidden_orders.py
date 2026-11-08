from datetime import date, datetime

from shop.orders import add_customer, add_order, orders_between
from tests.support import DatabaseTest


class HiddenOrdersTest(DatabaseTest):
    def test_all_of_the_last_day_is_included(self):
        ana = add_customer(self.conn, "Ana")
        morning = add_order(self.conn, ana, "10.00", datetime(2026, 3, 5, 0, 0))
        afternoon = add_order(self.conn, ana, "20.00", datetime(2026, 3, 5, 15, 0))
        late = add_order(self.conn, ana, "30.00", datetime(2026, 3, 5, 23, 59, 59))
        add_order(self.conn, ana, "40.00", datetime(2026, 3, 6, 0, 0))
        self.assertEqual(orders_between(self.conn, date(2026, 3, 1), date(2026, 3, 5)), [morning, afternoon, late])

    def test_a_single_day(self):
        ana = add_customer(self.conn, "Ana")
        noon = add_order(self.conn, ana, "10.00", datetime(2026, 3, 2, 12, 0))
        self.assertEqual(orders_between(self.conn, date(2026, 3, 2), date(2026, 3, 2)), [noon])
