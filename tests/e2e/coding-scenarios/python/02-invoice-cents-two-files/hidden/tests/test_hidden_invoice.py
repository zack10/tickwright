import unittest

from shop.invoice import invoice_total_cents


class HiddenInvoiceTest(unittest.TestCase):
    def test_line_amounts_are_exact(self):
        self.assertEqual(invoice_total_cents([("0.29", 1)]), 29)
        self.assertEqual(invoice_total_cents([("19.99", 1), ("5.01", 1)]), 2500)

    def test_discount_applies_once_to_the_total(self):
        self.assertEqual(invoice_total_cents([("19.99", 3), ("5.01", 1)], 15), 5523)
