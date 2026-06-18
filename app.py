from flask import Flask, render_template, request, jsonify
import sqlite3
import os
from datetime import datetime

app = Flask(__name__)
DB_PATH = "delivery.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_phone TEXT,
                address TEXT NOT NULL,
                items TEXT NOT NULL,
                delivery_date TEXT NOT NULL,
                delivery_time TEXT,
                driver TEXT,
                status TEXT NOT NULL DEFAULT 'รอส่ง',
                note TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
        """)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/orders", methods=["GET"])
def get_orders():
    date_from = request.args.get("from")
    date_to = request.args.get("to")
    status = request.args.get("status")

    query = "SELECT * FROM orders WHERE 1=1"
    params = []

    if date_from:
        query += " AND delivery_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND delivery_date <= ?"
        params.append(date_to)
    if status:
        query += " AND status = ?"
        params.append(status)

    query += " ORDER BY delivery_date ASC, delivery_time ASC"

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
        return jsonify([dict(r) for r in rows])


@app.route("/api/orders", methods=["POST"])
def create_order():
    data = request.json
    required = ["order_number", "customer_name", "address", "items", "delivery_date"]
    for field in required:
        if not data.get(field):
            return jsonify({"error": f"กรุณากรอก {field}"}), 400

    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO orders
               (order_number, customer_name, customer_phone, address, items,
                delivery_date, delivery_time, driver, status, note)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                data["order_number"],
                data["customer_name"],
                data.get("customer_phone", ""),
                data["address"],
                data["items"],
                data["delivery_date"],
                data.get("delivery_time", ""),
                data.get("driver", ""),
                data.get("status", "รอส่ง"),
                data.get("note", ""),
            ),
        )
        return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/orders/<int:order_id>", methods=["PUT"])
def update_order(order_id):
    data = request.json
    with get_db() as conn:
        conn.execute(
            """UPDATE orders SET
               order_number=?, customer_name=?, customer_phone=?, address=?,
               items=?, delivery_date=?, delivery_time=?, driver=?, status=?, note=?
               WHERE id=?""",
            (
                data["order_number"],
                data["customer_name"],
                data.get("customer_phone", ""),
                data["address"],
                data["items"],
                data["delivery_date"],
                data.get("delivery_time", ""),
                data.get("driver", ""),
                data.get("status", "รอส่ง"),
                data.get("note", ""),
                order_id,
            ),
        )
        return jsonify({"ok": True})


@app.route("/api/orders/<int:order_id>/status", methods=["PATCH"])
def update_status(order_id):
    data = request.json
    with get_db() as conn:
        conn.execute("UPDATE orders SET status=? WHERE id=?", (data["status"], order_id))
        return jsonify({"ok": True})


@app.route("/api/orders/<int:order_id>", methods=["DELETE"])
def delete_order(order_id):
    with get_db() as conn:
        conn.execute("DELETE FROM orders WHERE id=?", (order_id,))
        return jsonify({"ok": True})


@app.route("/api/summary")
def summary():
    date = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    with get_db() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) as count FROM orders WHERE delivery_date=? GROUP BY status",
            (date,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])


if __name__ == "__main__":
    init_db()
    print("เปิดเบราว์เซอร์ที่ http://localhost:5000")
    app.run(debug=True, port=5000)
