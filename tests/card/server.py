"""Serve the To Get card against the integration's real WebSocket handlers and list rules, with made-up data.

Each message the card sends is checked against the command's real schema and handled by the real function in
api.py, over a stand-in connection, with a real ToGetStore kept in memory. No Home Assistant instance is needed,
only the package (it's installed by requirements_test.txt). Used by drive.cjs; also handy for looking at the card
by hand:

    python tests/card/server.py        # then open http://127.0.0.1:8799/

Test hooks: /reset?data=demo|empty|none, /readonly?on=1 (a user who can look but not change), /fail?n=N (the next
N changes fail), /unload?on=1 (Home Assistant up but To Get not loaded, as during a restart), /store (the list as
saved), and POST /ws?quiet for a change from "another device".
"""
import json
import os
import sys
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from homeassistant.util import dt as dt_util  # noqa: E402  (first: Home Assistant swaps in its own voluptuous)
import voluptuous as vol  # noqa: E402
from voluptuous.humanize import humanize_error  # noqa: E402

from custom_components.to_get import api, store as store_module  # noqa: E402
from custom_components.to_get.const import DOMAIN  # noqa: E402
from custom_components.to_get.store import ToGetStore  # noqa: E402

PORT = int(os.environ.get("PORT", "8799"))
CARD = Path(os.environ.get("CARD") or REPO / "custom_components/to_get/www/to-get-card.js")
HANDLERS = {f._ws_command: f for f in vars(api).values() if callable(f) and hasattr(f, "_ws_command")}
READS = {"lists", "subscribe", "subscribe_summary"}
FAILURE = "Saving to Home Assistant failed (a made-up failure for the test). Try again."
LOCK = threading.Lock()   # requests come in on threads; handle them one at a time, as Home Assistant's loop would
STATE = {"readonly": False, "fail": 0, "unloaded": False, "log": []}
HASS = SimpleNamespace(data={})

# The subscriptions' events are fetched by the page after each change (see index.html), so nothing needs to be
# dispatched here; and the read-only switch stands in for Home Assistant's permission check.
api.async_dispatcher_connect = lambda *_: (lambda: None)
store_module.async_dispatcher_send = lambda *_: None
api.can_change = lambda hass, user, entry_id: not STATE["readonly"]


class Memory:
    """Home Assistant's Store, kept in memory: the made-up lists are never written anywhere."""

    def __init__(self, *_, **__) -> None: ...
    def async_delay_save(self, *_): ...
    async def async_save(self, *_): ...
    async def async_remove(self): ...


store_module.Store = Memory


class Entries:
    def __init__(self) -> None:
        self.entries: list[SimpleNamespace] = []

    def async_get_entry(self, entry_id):
        return next((e for e in self.entries if e.entry_id == entry_id), None)

    def async_entries(self, domain=None):
        return list(self.entries)


HASS.config_entries = Entries()


def new_list(entry_id: str, title: str, icon: str = "mdi:cart-outline") -> ToGetStore:
    store = ToGetStore(HASS, entry_id)
    HASS.config_entries.entries.append(SimpleNamespace(entry_id=entry_id, domain=DOMAIN, title=title,
                                                       data={"name": title}, options={"icon": icon}, runtime_data=store))
    return store


def ago(store: ToGetStore, uid: str, **delta) -> None:
    item = store.find(uid)
    item["done"] = (dt_util.utcnow() - timedelta(**delta)).isoformat()


def reset(data: str = "demo") -> None:
    HASS.config_entries.entries = []
    STATE.update(readonly=False, fail=0, unloaded=False, log=[])
    if data == "none":
        return
    s = new_list("demo", "To get")
    if data == "empty":
        return
    # Things got before, so their places are remembered.
    for name, place in [("Dog food", "Produce store"), ("Hay", "Produce store"), ("Gas bottle", "Servo"),
                        ("Toilet paper", "Woolies"), ("Fuel filter", "Repco")]:
        item, _ = s.add(name, place, by="Ems")
        s.update(item["uid"], done=True, by="Steve")
    s.clear_got()
    s.add("Silicone", "Bunnings", "clear, for the shower", by="Steve")
    s.add("Screws 40 mm", "Bunnings", by="Steve")
    s.add("Milk", "Woolies", "2 L", by="Ems")
    s.add("Bread", "Woolies", by="Ems")
    s.add("Water pump filter", "Online", "10 inch, 5 micron", by="Steve")
    s.add("Batteries AA", by="Ems")
    s.add("Matches", by="Ems")
    for name, place, days in [("Coffee", "Woolies", 0), ("Cable ties", "Bunnings", 1), ("Dog food", "Produce store", 3)]:
        item, _ = s.add(name, place, by="Ems")
        s.update(item["uid"], done=True, by="Steve")
        ago(s, item["uid"], days=days, minutes=5)


class Connection:
    def __init__(self) -> None:
        self.user = SimpleNamespace(name="Steve", is_admin=not STATE["readonly"], id="u1")
        self.subscriptions = {}
        self.result = None
        self.error = None
        self.events = []

    def send_result(self, _msg_id, result=None):
        self.result = result

    def send_error(self, _msg_id, code, message):
        self.error = {"code": code, "message": message}

    def send_message(self, message):
        self.events.append(message["event"])


def handle(msg: dict, logged: bool = True) -> tuple[int, object]:
    kind = msg.get("type", "").partition("/")[2]
    command = f"{DOMAIN}/{kind}"
    if STATE["unloaded"] or command not in HANDLERS:
        return 400, {"code": "unknown_command", "message": "Unknown command."}
    handler = HANDLERS[command]
    try:
        msg = handler._ws_schema(dict(msg, id=1)) if getattr(handler, "_ws_schema", None) else dict(msg, id=1)
    except vol.Invalid as err:
        return 400, {"code": "invalid_format", "message": humanize_error(msg, err)}
    if kind not in READS and logged:
        STATE["log"].append(msg)
        if STATE["fail"] > 0:
            STATE["fail"] -= 1
            return 400, {"code": "home_assistant_error", "message": FAILURE}
    connection = Connection()
    getattr(handler, "__wrapped__", handler)(HASS, connection, msg)
    if connection.error:
        return 400, connection.error
    return 200, {"result": connection.result, "events": connection.events}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): ...

    def _send(self, body: bytes, ctype: str = "application/json", code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value, code: int = 200) -> None:
        self._send(json.dumps(value).encode(), code=code)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        with LOCK:
            if url.path == "/":
                self._send((Path(__file__).parent / "index.html").read_bytes(), "text/html")
            elif url.path == "/card.js":
                self._send(CARD.read_bytes(), "text/javascript")
            elif url.path == "/reset":
                reset(q.get("data", "demo"))
                self._json({"ok": True})
            elif url.path == "/readonly":
                STATE["readonly"] = q.get("on") == "1"
                self._json({"ok": True})
            elif url.path == "/fail":
                STATE["fail"] = int(q.get("n", "1"))
                self._json({"ok": True})
            elif url.path == "/unload":
                STATE["unloaded"] = q.get("on") == "1"
                self._json({"ok": True})
            elif url.path == "/store":
                self._json([{"entry_id": e.entry_id, "items": e.runtime_data.items} for e in HASS.config_entries.entries])
            elif url.path == "/log":
                self._json(STATE["log"])
            else:
                self._send(b"not found", "text/plain", 404)

    def do_POST(self):
        url = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        with LOCK:
            code, value = handle(body, logged="quiet" not in url.query)
        self._json(value, code)


if __name__ == "__main__":
    reset()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
