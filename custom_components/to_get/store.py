"""One list: what's to get, where each thing is coming from, and what's been got. Kept in Home Assistant's .storage.

Every change is made in one go on the event loop (nothing awaits half way through), so two people ticking things
off at once can't lose either change. Saving follows a moment later.
"""
from __future__ import annotations

from typing import Any, Final
from uuid import uuid4

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN, MAX_GOT, MAX_KNOWN, MAX_NOTES, MAX_OPEN, MAX_PLACE, MAX_PLACES, MAX_SUMMARY, SIGNAL_ANY,
    SIGNAL_UPDATED, STATUS_GOT, STATUS_OPEN,
)

STORAGE_VERSION = 1
SAVE_DELAY = 1   # seconds

MISSING: Final = object()   # left out, as opposed to cleared

type ToGetConfigEntry = ConfigEntry["ToGetStore"]


class InvalidItem(ValueError):
    """Something the list can't take, with a message that can be shown to the person."""


class NotFound(KeyError):
    """No such thing on the list (someone else removed it, say)."""


def fold(text: str) -> str:
    """The same thing however it's typed: case and spacing don't matter."""
    return " ".join(text.split()).casefold()


def clean_line(value: Any, limit: int, what: str) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        raise InvalidItem(f"{what} can be up to {limit} characters")
    return text


def clean_notes(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > MAX_NOTES:
        raise InvalidItem(f"Notes can be up to {MAX_NOTES} characters")
    return text


def _now() -> str:
    """Microseconds too: things ticked off in the same second still go in the order they were got."""
    return dt_util.utcnow().isoformat()


class ToGetStore:
    """The things on one list, in list order, and the things it remembers (with the place each came from last)."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry_id}")
        self.items: list[dict[str, Any]] = []
        self.known: dict[str, dict[str, str]] = {}   # fold(name) -> {"name", "place", "ts"}
        self.closed = False   # unloaded: the list is gone until it's set up again

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.items = [i for i in data.get("items") or [] if isinstance(i, dict) and i.get("uid") and i.get("summary")]
        self.known = {k: v for k, v in (data.get("known") or {}).items() if isinstance(v, dict) and v.get("name")}

    async def async_flush(self) -> None:
        """Write now (the list is being unloaded), instead of a moment later."""
        await self._store.async_save(self._data())

    async def async_remove(self) -> None:
        await self._store.async_remove()

    # Reading ------------------------------------------------------------------------------------

    @property
    def open_items(self) -> list[dict[str, Any]]:
        return [i for i in self.items if i["status"] == STATUS_OPEN]

    @property
    def got_items(self) -> list[dict[str, Any]]:
        """Most recently got first."""
        return sorted((i for i in self.items if i["status"] == STATUS_GOT), key=lambda i: i.get("done") or "", reverse=True)

    def find(self, uid: str) -> dict[str, Any]:
        for item in self.items:
            if item["uid"] == uid:
                return item
        raise NotFound(uid)

    def places(self) -> list[str]:
        """Places to suggest: those on the list now (the busiest first), then ones things came from before."""
        seen: dict[str, str] = {}
        counts: dict[str, int] = {}
        for item in self.open_items:
            if place := item.get("place"):
                seen.setdefault(fold(place), place)
                counts[fold(place)] = counts.get(fold(place), 0) + 1
        ordered = sorted(seen, key=lambda k: -counts[k])
        for entry in sorted(self.known.values(), key=lambda e: e.get("ts", ""), reverse=True):
            if (place := entry.get("place")) and fold(place) not in seen:
                seen[fold(place)] = place
                ordered.append(fold(place))
        return [seen[k] for k in ordered[:MAX_PLACES]]

    def names(self) -> list[dict[str, str]]:
        """Things got or added before, the most recent first, with the place each came from last."""
        return [{"name": e["name"], "place": e.get("place", "")}
                for e in sorted(self.known.values(), key=lambda e: e.get("ts", ""), reverse=True)]

    # Changing -----------------------------------------------------------------------------------

    @callback
    def add(self, summary: Any, place: Any = MISSING, notes: Any = MISSING, by: str | None = None) -> tuple[dict[str, Any], str]:
        """Put something on the list. Returns the item and what happened: added, reopened or already.

        Something already on the list isn't added twice (a place or notes given are kept, though). Something got
        before goes back on, with its place and notes unless new ones are given. A new thing with no place given
        takes the place it came from last time, if it's been on the list before; an empty place means none.
        """
        summary = clean_line(summary, MAX_SUMMARY, "What's needed")
        if not summary:
            raise InvalidItem("Say what's needed")
        place = MISSING if place is MISSING else clean_line(place, MAX_PLACE, "The place")
        notes = MISSING if notes is MISSING else clean_notes(notes)
        key = fold(summary)

        if same := next((i for i in self.open_items if fold(i["summary"]) == key), None):
            if place is not MISSING and place:
                same["place"] = place
            if notes is not MISSING and notes:
                same["notes"] = notes
            self._remember(same)
            self._changed()
            return same, "already"

        if len(self.open_items) >= MAX_OPEN:
            raise InvalidItem(f"The list is full ({MAX_OPEN} things). Tick some off or remove some first")

        if got := next((i for i in self.got_items if fold(i["summary"]) == key), None):
            self.items.remove(got)
            got.update(summary=summary, status=STATUS_OPEN, done=None, done_by=None, added=_now(), added_by=by)
            if place is not MISSING:
                got["place"] = place
            if notes is not MISSING:
                got["notes"] = notes
            self.items.append(got)
            self._remember(got)
            self._changed()
            return got, "reopened"

        if place is MISSING:
            place = self.known.get(key, {}).get("place", "")
        item = {
            "uid": uuid4().hex, "summary": summary, "place": place, "notes": "" if notes is MISSING else notes,
            "status": STATUS_OPEN, "added": _now(), "added_by": by, "done": None, "done_by": None,
        }
        self.items.append(item)
        self._remember(item)
        self._changed()
        return item, "added"

    @callback
    def update(self, uid: str, *, summary: Any = MISSING, place: Any = MISSING, notes: Any = MISSING,
               done: Any = MISSING, by: str | None = None) -> dict[str, Any]:
        """Change a thing on the list: rename it, say where it's coming from, add notes, tick it off or put it back."""
        item = self.find(uid)
        changes: dict[str, Any] = {}
        if summary is not MISSING:
            changes["summary"] = clean_line(summary, MAX_SUMMARY, "What's needed")
            if not changes["summary"]:
                raise InvalidItem("Say what's needed")
        name = changes.get("summary", item["summary"])
        will_be_open = item["status"] == STATUS_OPEN if done is MISSING else not done
        if will_be_open and (other := next((i for i in self.open_items if i is not item and fold(i["summary"]) == fold(name)), None)):
            raise InvalidItem(f"{other['summary']} is already on the list")
        if place is not MISSING:
            changes["place"] = clean_line(place, MAX_PLACE, "The place")
        if notes is not MISSING:
            changes["notes"] = clean_notes(notes)
        if done is not MISSING:
            got = bool(done)
            if got and item["status"] != STATUS_GOT:
                changes.update(status=STATUS_GOT, done=_now(), done_by=by)
            elif not got and item["status"] != STATUS_OPEN:
                if len(self.open_items) >= MAX_OPEN:
                    raise InvalidItem(f"The list is full ({MAX_OPEN} things). Tick some off or remove some first")
                changes.update(status=STATUS_OPEN, done=None, done_by=None)
        renamed_from = fold(item["summary"]) if fold(changes.get("summary", item["summary"])) != fold(item["summary"]) else None
        item.update(changes)
        # A rename is usually a fix (a typo): stop suggesting the old name, unless something else still has it.
        if renamed_from and not any(fold(i["summary"]) == renamed_from for i in self.items):
            self.known.pop(renamed_from, None)
        self._remember(item)
        self._prune()
        self._changed()
        return item

    @callback
    def remove(self, uids: list[str]) -> int:
        """Take things off the list altogether (not ticked off: gone). Unknown ones are ignored."""
        wanted = set(uids)
        before = len(self.items)
        self.items = [i for i in self.items if i["uid"] not in wanted]
        removed = before - len(self.items)
        if removed:
            self._changed()
        return removed

    @callback
    def clear_got(self) -> int:
        """Take everything that's been got off the list. What it's remembered stays."""
        return self.remove([i["uid"] for i in self.items if i["status"] == STATUS_GOT])

    @callback
    def move(self, uid: str, previous_uid: str | None) -> None:
        """Put a thing just after another one, or first when there's no other."""
        item = self.find(uid)
        if previous_uid == uid:
            return
        after = self.find(previous_uid) if previous_uid else None
        self.items.remove(item)
        self.items.insert(self.items.index(after) + 1 if after else 0, item)
        self._changed()

    # Inside -------------------------------------------------------------------------------------

    def _remember(self, item: dict[str, Any]) -> None:
        """Keep the thing's name, and where it came from if that's known, for the next time it's needed."""
        key = fold(item["summary"])
        entry = self.known.get(key, {})
        self.known[key] = {"name": item["summary"], "place": item.get("place") or entry.get("place", ""), "ts": _now()}
        if len(self.known) > MAX_KNOWN:
            for old in sorted(self.known, key=lambda k: self.known[k].get("ts", ""))[: len(self.known) - MAX_KNOWN]:
                del self.known[old]

    def _prune(self) -> None:
        got = self.got_items
        if len(got) > MAX_GOT:
            drop = {i["uid"] for i in got[MAX_GOT:]}
            self.items = [i for i in self.items if i["uid"] not in drop]

    def _data(self) -> dict[str, Any]:
        return {"items": self.items, "known": self.known}

    @callback
    def _changed(self) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY)
        async_dispatcher_send(self.hass, SIGNAL_UPDATED.format(self.entry_id))
        async_dispatcher_send(self.hass, SIGNAL_ANY)
