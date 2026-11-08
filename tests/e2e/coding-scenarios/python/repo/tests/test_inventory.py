import unittest

from shop.inventory import reorder_list, reserve


class InventoryTest(unittest.TestCase):
    def test_reorder_list(self):
        self.assertEqual(reorder_list({"a": 2, "b": 10, "c": 5}, 5), ["a"])

    def test_reserve(self):
        self.assertEqual(reserve({"a": 3}, "a", 2), {"a": 1})

    def test_reserve_refuses_more_than_available(self):
        with self.assertRaises(ValueError):
            reserve({"a": 1}, "a", 2)
