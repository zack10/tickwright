"""Each test gets empty tables."""

import unittest

from shop.db import connect, reset


class DatabaseTest(unittest.TestCase):
    def setUp(self):
        self.conn = connect()
        reset(self.conn)

    def tearDown(self):
        self.conn.close()
