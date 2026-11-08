# benchmark-orders (Python, PostgreSQL)

Orders, revenue reports and customer statistics stored in PostgreSQL.

The tests need a PostgreSQL server; `DATABASE_URL` says where it is
(e.g. `postgresql://postgres:test@localhost:5432/postgres`). Each test
recreates the tables, so use a database you don't need.

```bash
pip install -r requirements.txt
python -m unittest
```
