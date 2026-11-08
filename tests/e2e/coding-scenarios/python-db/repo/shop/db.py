"""Database connection and schema."""

import os

import psycopg

SCHEMA = """
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
CREATE TABLE customers (
    id serial PRIMARY KEY,
    name text NOT NULL UNIQUE
);
CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers (id),
    total numeric(10, 2) NOT NULL,
    status text NOT NULL,
    created_at timestamp NOT NULL
);
"""


def connect():
    """A connection to the database in DATABASE_URL."""
    return psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)


def reset(conn):
    """Recreates the tables, empty."""
    conn.execute(SCHEMA)
