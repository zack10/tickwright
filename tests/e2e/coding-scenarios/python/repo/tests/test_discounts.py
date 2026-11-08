import unittest

from shop.discounts import discount_rate, discounted_total


class DiscountTest(unittest.TestCase):
    def test_small_orders_get_no_discount(self):
        self.assertEqual(discount_rate(50), 0.0)

    def test_tiers(self):
        self.assertEqual(discount_rate(150), 0.10)
        self.assertEqual(discount_rate(600), 0.20)

    def test_discounted_total(self):
        self.assertEqual(discounted_total(200), 180.0)
