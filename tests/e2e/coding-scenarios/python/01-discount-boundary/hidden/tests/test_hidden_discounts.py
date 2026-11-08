import unittest

from shop.discounts import discount_rate, discounted_total


class HiddenDiscountTest(unittest.TestCase):
    def test_tiers_start_at_their_minimum(self):
        self.assertEqual(discount_rate(100), 0.10)
        self.assertEqual(discount_rate(500), 0.20)
        self.assertEqual(discount_rate(99.99), 0.0)

    def test_discounted_total_on_a_boundary(self):
        self.assertEqual(discounted_total(100), 90.0)
