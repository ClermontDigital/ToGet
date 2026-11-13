"""WebSocket API for the To Get card.

Anyone signed in to Home Assistant can look at a list, as they can at any to-do list. Changing it needs the same
permission as changing the list's to-do entity, so a read-only user can look but not change anything.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.auth.models import User
from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import CONF_ICON, DEFAULT_ICON, DOMAIN, FIRST_FEW, SIGNAL_ANY, SIGNAL_UPDATED
from .store import MISSING, InvalidItem, NotFound, ToGetStore

NOT_ALLOWED = "Your Home Assistant user can look at this list but not change it"
GONE = "That list isn't there any more"


def lists(hass: HomeAssistant) -> list[ConfigEntry]:
    """The lists that are set up, in the order they were added."""
    return [e for e in hass.config_entries.async_entries(DOMAIN) if store_of(e) is not None]


def store_of(entry: ConfigEntry | None) -> ToGetStore | None:
    store = getattr(entry, "runtime_data", None) if entry else None
    return store if isinstance(store, ToGetStore) and not store.closed else None


def _entry(hass: HomeAssistant, entry_id: str) -> ConfigEntry | None:
    entry = hass.config_entries.async_get_entry(entry_id)
    return entry if entry and entry.domain == DOMAIN else None


def describe(entry: ConfigEntry) -> dict[str, Any]:
    return {"entry_id": entry.entry_id, "name": entry.title,
            "icon": entry.options.get(CONF_ICON) or entry.data.get(CONF_ICON) or DEFAULT_ICON}


def can_change(hass: HomeAssistant, user: User | None, entry_id: str) -> bool:
    """Whether this person may change the list: if they could change its to-do entity."""
    if user is None or user.is_admin:
        return True
    entity_id = er.async_get(hass).async_get_entity_id("todo", DOMAIN, entry_id)
    return entity_id is not None and user.permissions.check_entity(entity_id, POLICY_CONTROL)


def snapshot(hass: HomeAssistant, entry: ConfigEntry, store: ToGetStore, user: User | None) -> dict[str, Any]:
    """Everything the card shows for one list."""
    return {
        "list": describe(entry),
        "items": store.open_items,
        "got": store.got_items,
        "places": store.places(),
        "names": store.names(),
        "can_change": can_change(hass, user, entry.entry_id),
    }


def summary(hass: HomeAssistant, entry_id: str | None = None) -> dict[str, Any]:
    """How many things are to get on each list (or just the one), and the first few of them, for a count strip."""
    out = []
    for entry in lists(hass):
        if entry_id and entry.entry_id != entry_id:
            continue
        items = store_of(entry).open_items
        out.append({**describe(entry), "count": len(items), "first": [i["summary"] for i in items[:FIRST_FEW]]})
    return {"lists": out, "total": sum(x["count"] for x in out)}


def _name(connection: websocket_api.ActiveConnection) -> str | None:
    return connection.user.name if connection.user else None


def _resolve(hass: HomeAssistant, connection: websocket_api.ActiveConnection,
             msg: dict[str, Any]) -> tuple[ConfigEntry, ToGetStore] | None:
    """The list a change is for, if it's there and this person may change it."""
    entry = _entry(hass, msg["entry_id"])
    if not (store := store_of(entry)):
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, GONE)
        return None
    if not can_change(hass, connection.user, entry.entry_id):
        connection.send_error(msg["id"], websocket_api.ERR_UNAUTHORIZED, NOT_ALLOWED)
        return None
    return entry, store


def _run(connection: websocket_api.ActiveConnection, msg: dict[str, Any], change) -> None:
    try:
        result = change()
    except InvalidItem as err:
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, str(err))
    except NotFound:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "That isn't on the list any more")
    else:
        connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/lists"})
@callback
def ws_lists(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], summary(hass)["lists"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe", vol.Required("entry_id"): str})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """One list, now and after every change. {"gone": true} while it isn't set up (being reloaded or deleted)."""
    entry_id = msg["entry_id"]
    if not store_of(_entry(hass, entry_id)):
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, GONE)
        return

    @callback
    def _forward() -> None:
        entry = _entry(hass, entry_id)
        store = store_of(entry)
        body = snapshot(hass, entry, store, connection.user) if store else {"gone": True}
        connection.send_message(websocket_api.event_message(msg["id"], body))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATED.format(entry_id), _forward)
    connection.send_result(msg["id"])
    _forward()


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe_summary", vol.Optional("entry_id"): str})
@callback
def ws_subscribe_summary(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """How many things are to get (on every list, or one), now and after every change."""

    @callback
    def _forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], summary(hass, msg.get("entry_id"))))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_ANY, _forward)
    connection.send_result(msg["id"])
    _forward()


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/add",
    vol.Required("entry_id"): str,
    vol.Required("summary"): str,
    vol.Optional("place"): str,
    vol.Optional("notes"): str,
})
@callback
def ws_add(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Put something on the list. Leaving the place out uses the place it came from last time, if any."""
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found

    def change() -> dict[str, Any]:
        item, how = store.add(msg["summary"], msg.get("place", MISSING), msg.get("notes", MISSING), by=_name(connection))
        return {"item": item, "how": how}

    _run(connection, msg, change)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/update",
    vol.Required("entry_id"): str,
    vol.Required("uid"): str,
    vol.Optional("summary"): str,
    vol.Optional("place"): str,
    vol.Optional("notes"): str,
    vol.Optional("done"): bool,
})
@callback
def ws_update(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Rename a thing, say where it's coming from, change its notes, tick it off or put it back on the list."""
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found
    fields = {k: msg[k] for k in ("summary", "place", "notes", "done") if k in msg}
    _run(connection, msg, lambda: store.update(msg["uid"], **fields, by=_name(connection)))


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/remove",
    vol.Required("entry_id"): str,
    vol.Required("uids"): [str],
})
@callback
def ws_remove(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found
    _run(connection, msg, lambda: {"removed": store.remove(msg["uids"])})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/clear", vol.Required("entry_id"): str})
@callback
def ws_clear(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Take everything that's been got off the list."""
    if not (found := _resolve(hass, connection, msg)):
        return
    _, store = found
    _run(connection, msg, lambda: {"removed": store.clear_got()})


@callback
def async_register_api(hass: HomeAssistant) -> None:
    """Register the commands (once per HA run, from async_setup)."""
    for command in (ws_lists, ws_subscribe, ws_subscribe_summary, ws_add, ws_update, ws_remove, ws_clear):
        websocket_api.async_register_command(hass, command)
