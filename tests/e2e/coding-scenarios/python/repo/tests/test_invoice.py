import unittest

from shop.invoice import invoice_total_cents, line_cents


class InvoiceTest(unittest.TestCase):
    def test_line(self):
        self.assertEqual(line_cents("10.00", 2), 2000)

    def test_total(self):
        self.assertEqual(invoice_total_cents([("10.00", 2), ("5.50", 1)]), 2550)

    def test_total_with_discount(self):
        self.assertEqual(invoice_total_cents([("10.00", 2), ("5.50", 1)], 10), 2295)
