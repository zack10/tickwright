import unittest

from shop.inventory import reorder_list


class HiddenInventoryTest(unittest.TestCase):
    def test_sold_out_items_are_reordered(self):
        self.assertEqual(sorted(reorder_list({"aa": 0, "aaa": 3, "d": 9}, 5)), ["aa", "aaa"])
