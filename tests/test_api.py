"""実際にサーバーを起動して HTTP 経由で API を検証する結合テスト。"""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import db
from server import OrderServer


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self.tmp.name) / "test.db"
        db.init_db(db_path)
        self.server = OrderServer(("127.0.0.1", 0), db_path)
        self.server.log_requests = False
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            headers = {}
            payload = None
            if body is not None:
                payload = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=payload, headers=headers)
            res = conn.getresponse()
            raw = res.read()
            content_type = res.getheader("Content-Type", "")
            data = json.loads(raw) if content_type.startswith("application/json") else raw
            return res.status, data
        finally:
            conn.close()

    def ok(self, method, path, body=None):
        status, data = self.request(method, path, body)
        self.assertEqual(status, 200, data)
        return data

    def menu_items(self):
        menu = self.ok("GET", "/api/menu")
        return [item for c in menu["categories"] for item in c["items"]]

    def start(self, table_id=1, guests=2):
        return self.ok("POST", f"/api/tables/{table_id}/session", {"guests": guests})


class MenuTest(ServerTestCase):
    def test_menu_has_categories_and_items(self):
        menu = self.ok("GET", "/api/menu")
        self.assertGreater(len(menu["categories"]), 0)
        self.assertTrue(all(c["items"] for c in menu["categories"]))

    def test_sold_out_toggle(self):
        item = self.menu_items()[0]
        updated = self.ok("PATCH", f"/api/menu/{item['id']}", {"sold_out": True})
        self.assertTrue(updated["sold_out"])
        status, _ = self.request("PATCH", f"/api/menu/{item['id']}", {"sold_out": "yes"})
        self.assertEqual(status, 400)


class OrderFlowTest(ServerTestCase):
    def test_full_flow_from_seating_to_checkout(self):
        a, b = self.menu_items()[:2]
        table = self.start(guests=3)
        self.assertEqual(table["status"], "occupied")
        self.assertEqual(table["session"]["guests"], 3)

        res = self.ok("POST", "/api/tables/1/orders", {"items": [
            {"menu_item_id": a["id"], "quantity": 2},
            {"menu_item_id": b["id"], "quantity": 1},
        ]})
        self.assertEqual(res["table"]["total"], a["price"] * 2 + b["price"])

        kitchen = self.ok("GET", "/api/kitchen")["orders"]
        self.assertEqual(len(kitchen), 1)
        self.assertEqual(kitchen[0]["table_id"], 1)
        item_id = kitchen[0]["items"][0]["id"]
        self.ok("PATCH", f"/api/order-items/{item_id}", {"status": "cooking"})
        self.ok("PATCH", f"/api/order-items/{item_id}", {"status": "served"})
        self.assertEqual(len(self.ok("GET", "/api/kitchen")["orders"][0]["items"]), 1)

        table = self.ok("POST", "/api/tables/1/checkout-request")
        self.assertEqual(table["status"], "checkout")
        self.assertEqual([c["kind"] for c in self.ok("GET", "/api/calls")["calls"]], ["checkout"])
        status, _ = self.request("POST", "/api/tables/1/orders", {"items": [{"menu_item_id": a["id"], "quantity": 1}]})
        self.assertEqual(status, 409)

        closed = self.ok("POST", "/api/tables/1/close")
        self.assertEqual(closed["closed_session"]["total"], a["price"] * 2 + b["price"])
        self.assertEqual(closed["table"]["status"], "vacant")
        self.assertEqual(closed["table"]["orders"], [])
        self.assertEqual(self.ok("GET", "/api/kitchen")["orders"], [])
        self.assertEqual(self.ok("GET", "/api/calls")["calls"], [])

    def test_cannot_order_before_seating(self):
        item = self.menu_items()[0]
        status, data = self.request("POST", "/api/tables/1/orders", {"items": [{"menu_item_id": item["id"], "quantity": 1}]})
        self.assertEqual(status, 409, data)

    def test_cannot_seat_twice(self):
        self.start()
        status, _ = self.request("POST", "/api/tables/1/session", {"guests": 2})
        self.assertEqual(status, 409)

    def test_sold_out_item_is_rejected(self):
        item = self.menu_items()[0]
        self.ok("PATCH", f"/api/menu/{item['id']}", {"sold_out": True})
        self.start()
        status, data = self.request("POST", "/api/tables/1/orders", {"items": [{"menu_item_id": item["id"], "quantity": 1}]})
        self.assertEqual(status, 409)
        self.assertIn(item["name"], data["error"])

    def test_invalid_order_input_is_rejected(self):
        item_id = self.menu_items()[0]["id"]
        self.start()
        for items in (
            [],
            [{"menu_item_id": item_id, "quantity": 0}],
            [{"menu_item_id": item_id, "quantity": True}],
            [{"menu_item_id": item_id, "quantity": "1"}],
            [{"menu_item_id": item_id, "quantity": 21}],
            [{"menu_item_id": item_id, "quantity": 15}, {"menu_item_id": item_id, "quantity": 15}],
            [{"menu_item_id": 99999, "quantity": 1}],
        ):
            with self.subTest(items=items):
                status, _ = self.request("POST", "/api/tables/1/orders", {"items": items})
                self.assertEqual(status, 400)

    def test_invalid_guest_count_and_json(self):
        status, _ = self.request("POST", "/api/tables/1/session", {"guests": 0})
        self.assertEqual(status, 400)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/tables/1/session", body=b"{broken", headers={"Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()

    def test_unknown_table_and_route(self):
        self.assertEqual(self.request("GET", "/api/tables/999")[0], 404)
        self.assertEqual(self.request("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.request("PATCH", "/api/menu")[0], 405)

    def test_cancelled_items_are_excluded_from_total(self):
        a, b = self.menu_items()[:2]
        self.start()
        res = self.ok("POST", "/api/tables/1/orders", {"items": [
            {"menu_item_id": a["id"], "quantity": 1},
            {"menu_item_id": b["id"], "quantity": 1},
        ]})
        cancel_id = res["order"]["items"][0]["id"]
        self.ok("PATCH", f"/api/order-items/{cancel_id}", {"status": "cancelled"})
        self.assertEqual(self.ok("GET", "/api/tables/1")["total"], b["price"])

    def test_invalid_status_transition(self):
        item = self.menu_items()[0]
        self.start()
        res = self.ok("POST", "/api/tables/1/orders", {"items": [{"menu_item_id": item["id"], "quantity": 1}]})
        item_id = res["order"]["items"][0]["id"]
        self.assertEqual(self.request("PATCH", f"/api/order-items/{item_id}", {"status": "served"})[0], 409)
        self.ok("PATCH", f"/api/order-items/{item_id}", {"status": "cancelled"})
        self.assertEqual(self.request("PATCH", f"/api/order-items/{item_id}", {"status": "pending"})[0], 409)

    def test_order_snapshot_keeps_price_and_tables_are_independent(self):
        item = self.menu_items()[0]
        self.start(1)
        self.start(2)
        self.ok("POST", "/api/tables/1/orders", {"items": [{"menu_item_id": item["id"], "quantity": 1}]})
        self.assertEqual(self.ok("GET", "/api/tables/2")["total"], 0)
        self.assertEqual(self.ok("GET", "/api/tables/1")["orders"][0]["items"][0]["unit_price"], item["price"])


class CallTest(ServerTestCase):
    def test_calls_are_deduplicated_and_resolved(self):
        self.ok("POST", "/api/tables/1/calls", {"kind": "staff"})
        self.ok("POST", "/api/tables/1/calls", {"kind": "staff"})
        self.ok("POST", "/api/tables/1/calls", {"kind": "water"})
        calls = self.ok("GET", "/api/calls")["calls"]
        self.assertEqual(sorted(c["kind"] for c in calls), ["staff", "water"])
        for call in calls:
            self.ok("POST", f"/api/calls/{call['id']}/resolve")
        self.assertEqual(self.ok("GET", "/api/calls")["calls"], [])

    def test_checkout_kind_cannot_be_created_directly(self):
        self.assertEqual(self.request("POST", "/api/tables/1/calls", {"kind": "checkout"})[0], 400)


class EventStreamTest(ServerTestCase):
    def test_subscriber_receives_events_after_change(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", "/api/events")
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            self.assertTrue(res.getheader("Content-Type").startswith("text/event-stream"))
            self.assertEqual(res.fp.readline(), b": connected\n")  # 購読登録済み

            self.ok("POST", "/api/tables/3/calls", {"kind": "staff"})
            events = []
            while len(events) < 2:
                line = res.fp.readline()
                if line.startswith(b"data: "):
                    events.append(json.loads(line[6:]))
            self.assertEqual(events, [{"type": "calls"}, {"type": "table", "table_id": 3}])
        finally:
            conn.close()


class StaticFileTest(ServerTestCase):
    def test_pages_are_served(self):
        for path in ("/", "/table", "/kitchen", "/staff", "/table.js", "/style.css"):
            with self.subTest(path=path):
                status, _ = self.request("GET", path)
                self.assertEqual(status, 200)

    def test_path_traversal_is_blocked(self):
        for path in ("/../server.py", "/..%2fserver.py", "/static/../../server.py"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)


if __name__ == "__main__":
    unittest.main()
