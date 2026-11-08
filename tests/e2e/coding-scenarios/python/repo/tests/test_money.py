import unittest

from shop.money import format_cents, to_cents


class MoneyTest(unittest.TestCase):
    def test_to_cents(self):
        self.assertEqual(to_cents("10.50"), 1050)
        self.assertEqual(to_cents(3), 300)

    def test_format_cents(self):
        self.assertEqual(format_cents(1050), "10.50")
        self.assertEqual(format_cents(-5), "-0.05")
