"""The list as a Home Assistant to-do list: it shows in the To-do panel, works with Assist ("add milk to the To get
list") and its state is how many things are still to get. A thing's notes are the to-do item's description; its
place is To Get's own, so it shows on the To Get card (and the to_get.add action sets it)."""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from homeassistant.components.todo import (
    TodoItem, TodoItemStatus, TodoListEntity, TodoListEntityFeature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import ATTR_ITEM, ATTR_NOTES, ATTR_PLACE, CONF_ICON, DEFAULT_ICON, DOMAIN, SIGNAL_UPDATED, STATUS_GOT
from .store import MISSING, InvalidItem, NotFound, ToGetConfigEntry, ToGetStore

CONTEXT_FRESH = 2   # seconds: a context older than this belongs to an earlier action


async def async_setup_entry(hass: HomeAssistant, entry: ToGetConfigEntry,
                            async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([ToGetList(entry, entry.runtime_data)])


def _when(value: str | None) -> datetime | None:
    return dt_util.parse_datetime(value) if value else None


class ToGetList(TodoListEntity):
    _attr_has_entity_name = True
    _attr_name = None
    _attr_should_poll = False
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.MOVE_TODO_ITEM
        | TodoListEntityFeature.SET_DESCRIPTION_ON_ITEM
    )

    def __init__(self, entry: ToGetConfigEntry, store: ToGetStore) -> None:
        self._entry = entry
        self._store = store
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)}, name=entry.title, manufacturer="To Get",
            entry_type=DeviceEntryType.SERVICE,
        )
        self._refresh()

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(
            self.hass, SIGNAL_UPDATED.format(self._entry.entry_id), self._updated))

    @callback
    def _refresh(self) -> None:
        self._attr_icon = self._entry.options.get(CONF_ICON) or self._entry.data.get(CONF_ICON) or DEFAULT_ICON
        self._attr_todo_items = [
            TodoItem(summary=i["summary"], uid=i["uid"], description=i.get("notes") or None,
                     status=TodoItemStatus.COMPLETED if i["status"] == STATUS_GOT else TodoItemStatus.NEEDS_ACTION,
                     completed=_when(i.get("done")) if i["status"] == STATUS_GOT else None)
            for i in self._store.items
        ]

    @callback
    def _updated(self) -> None:
        if self._store.closed:
            return
        self._refresh()
        self.async_write_ha_state()

    async def _by(self) -> str | None:
        """Who's making the change: the person behind the action that's running now, if there is one.

        Home Assistant sets the entity's context just before an action calls it, and keeps it for a while
        afterwards; Assist calls the entity directly, without one. So an older context isn't this change's."""
        fresh = self._context_set is not None and time.time() - self._context_set < CONTEXT_FRESH
        user_id = self._context.user_id if self._context and fresh else None
        user = await self.hass.auth.async_get_user(user_id) if user_id else None
        return user.name if user else None

    def _do(self, change):
        try:
            return change()
        except InvalidItem as err:
            raise ServiceValidationError(str(err)) from err
        except NotFound as err:
            raise HomeAssistantError("That isn't on the list any more") from err

    async def async_create_todo_item(self, item: TodoItem) -> None:
        by = await self._by()
        notes = item.description if item.description else MISSING
        added, _ = self._do(lambda: self._store.add(item.summary, notes=notes, by=by))
        if item.status == TodoItemStatus.COMPLETED:
            self._do(lambda: self._store.update(added["uid"], done=True, by=by))

    async def async_update_todo_item(self, item: TodoItem) -> None:
        by = await self._by()
        fields: dict[str, Any] = {}
        if item.summary is not None:
            fields["summary"] = item.summary
        if item.status is not None:
            fields["done"] = item.status == TodoItemStatus.COMPLETED
        # No description means "clear it" from the To-do panel, but Assist's "mark it done" sends none either:
        # only ticking something off or putting it back, with the name unchanged, leaves the notes alone.
        current = next((i for i in self._store.items if i["uid"] == item.uid), None)
        just_ticked = (current is not None and item.description is None
                       and (item.summary is None or item.summary == current["summary"])
                       and "done" in fields and fields["done"] != (current["status"] == STATUS_GOT))
        if not just_ticked:
            fields["notes"] = item.description or ""
        self._do(lambda: self._store.update(item.uid, **fields, by=by))

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        self._store.remove(uids)

    async def async_move_todo_item(self, uid: str, previous_uid: str | None = None) -> None:
        self._do(lambda: self._store.move(uid, previous_uid))

    async def async_add_with_place(self, **fields: Any) -> None:
        """The to_get.add action: put something on the list, with where it's coming from."""
        by = await self._by()
        self._do(lambda: self._store.add(fields[ATTR_ITEM], fields.get(ATTR_PLACE, MISSING),
                                         fields.get(ATTR_NOTES, MISSING), by=by))
