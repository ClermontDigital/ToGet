"""The list as a Home Assistant to-do list, and the to_get.add action."""
import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import Context
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from custom_components.to_get.const import DOMAIN

ENTITY = "todo.to_get"


async def items(hass, hass_ws_client):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "todo/item/list", "entity_id": ENTITY})
    msg = await client.receive_json()
    assert msg["success"], msg
    return msg["result"]["items"]


async def test_entity_device_and_state(hass, entry):
    state = hass.states.get(ENTITY)
    assert state.state == "0" and state.attributes["icon"] == "mdi:cart-outline"
    assert er.async_get(hass).async_get(ENTITY).unique_id == entry.entry_id
    device = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)[0]
    assert device.name == "To get"


async def test_native_add_update_and_remove(hass, entry, hass_ws_client, hass_admin_user):
    store = entry.runtime_data
    ctx = Context(user_id=hass_admin_user.id)
    await hass.services.async_call("todo", "add_item", {"item": "Milk", "description": "2 L"},
                                   target={"entity_id": ENTITY}, blocking=True, context=ctx)
    await hass.services.async_call("todo", "add_item", {"item": "Bread"}, target={"entity_id": ENTITY}, blocking=True)
    assert hass.states.get(ENTITY).state == "2"
    [milk, bread] = await items(hass, hass_ws_client)
    assert milk["summary"] == "Milk" and milk["description"] == "2 L" and milk["status"] == "needs_action"
    assert store.open_items[0]["added_by"] == hass_admin_user.name and store.open_items[1]["added_by"] is None

    await hass.services.async_call("todo", "update_item", {"item": "Milk", "status": "completed"},
                                   target={"entity_id": ENTITY}, blocking=True)
    assert hass.states.get(ENTITY).state == "1"
    milk = (await items(hass, hass_ws_client))[0]
    assert milk["status"] == "completed" and milk["completed"] and milk["description"] == "2 L"

    await hass.services.async_call("todo", "update_item", {"item": milk["uid"], "rename": "Milk 2 L", "description": ""},
                                   target={"entity_id": ENTITY}, blocking=True)
    assert store.items[0]["summary"] == "Milk 2 L" and store.items[0]["notes"] == ""

    await hass.services.async_call("todo", "remove_completed_items", target={"entity_id": ENTITY}, blocking=True)
    assert [i["summary"] for i in await items(hass, hass_ws_client)] == ["Bread"]
    await hass.services.async_call("todo", "remove_item", {"item": "Bread"}, target={"entity_id": ENTITY}, blocking=True)
    assert hass.states.get(ENTITY).state == "0"


async def test_native_add_keeps_the_remembered_place(hass, entry):
    store = entry.runtime_data
    item, _ = store.add("Dog food", "Produce store")
    store.remove([item["uid"]])
    await hass.services.async_call("todo", "add_item", {"item": "dog food"}, target={"entity_id": ENTITY}, blocking=True)
    assert store.open_items[0]["place"] == "Produce store"


async def test_native_move(hass, entry, hass_ws_client):
    store = entry.runtime_data
    a, _ = store.add("A")
    b, _ = store.add("B")
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "todo/item/move", "entity_id": ENTITY, "uid": b["uid"]})
    assert (await client.receive_json())["success"]
    assert [i["summary"] for i in store.items] == ["B", "A"]


async def test_changes_from_the_card_show_on_the_entity(hass, entry):
    entry.runtime_data.add("Milk")
    await hass.async_block_till_done()
    assert hass.states.get(ENTITY).state == "1"


async def test_add_action_with_a_place(hass, entry):
    store = entry.runtime_data
    await hass.services.async_call(DOMAIN, "add", {"item": "Silicone", "place": "Bunnings", "notes": "clear"},
                                   target={"entity_id": ENTITY}, blocking=True)
    await hass.services.async_call(DOMAIN, "add", {"item": "silicone"}, target={"entity_id": ENTITY}, blocking=True)
    assert len(store.items) == 1
    item = store.items[0]
    assert item["summary"] == "Silicone" and item["place"] == "Bunnings" and item["notes"] == "clear"
    assert hass.states.get(ENTITY).state == "1"


async def test_add_action_rejects_an_empty_item(hass, entry):
    with pytest.raises(Exception):
        await hass.services.async_call(DOMAIN, "add", {"item": ""}, target={"entity_id": ENTITY}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add", {"item": "   "}, target={"entity_id": ENTITY}, blocking=True)


async def test_icon_option_and_rename(hass, entry):
    hass.config_entries.async_update_entry(entry, title="Shopping", options={"icon": "mdi:basket"})
    await hass.async_block_till_done()
    assert hass.states.get(ENTITY).attributes["icon"] == "mdi:basket"
    device = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)[0]
    assert device.name == "Shopping"


async def test_reload_and_remove(hass, entry, hass_storage):
    entry.runtime_data.add("Milk", "Woolies")
    assert await hass.config_entries.async_reload(entry.entry_id)   # saved on the way out, not lost
    await hass.async_block_till_done()
    assert hass.states.get(ENTITY).state == "1"
    assert entry.runtime_data.items[0]["place"] == "Woolies"
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert f"{DOMAIN}.{entry.entry_id}" not in hass_storage


def entity(hass):
    return hass.data["todo"].get_entity(ENTITY)


async def test_assist_marking_done_keeps_the_notes(hass, entry):
    """Assist's "mark milk as done" sends the item with no description: that isn't "clear the notes"."""
    item, _ = entry.runtime_data.add("Milk", "Woolies", "2 L full cream")
    await entity(hass).async_update_todo_item(TodoItem(uid=item["uid"], summary="Milk", status=TodoItemStatus.COMPLETED))
    assert item["status"] == "completed" and item["notes"] == "2 L full cream"
    await entity(hass).async_update_todo_item(TodoItem(uid=item["uid"], summary="Milk", status=TodoItemStatus.NEEDS_ACTION))
    assert item["status"] == "needs_action" and item["notes"] == "2 L full cream"
    # The To-do panel's dialog clears notes the same way, with the status unchanged.
    await entity(hass).async_update_todo_item(TodoItem(uid=item["uid"], summary="Milk", status=TodoItemStatus.NEEDS_ACTION))
    assert item["notes"] == ""


async def test_assist_adds_are_not_put_down_to_the_last_person(hass, entry, hass_admin_user):
    ctx = Context(user_id=hass_admin_user.id)
    await hass.services.async_call("todo", "add_item", {"item": "Bread"}, target={"entity_id": ENTITY}, blocking=True, context=ctx)
    # Assist calls the entity directly, with no context of its own: the admin's from just before isn't it.
    entity(hass)._context_set -= 10
    await entity(hass).async_create_todo_item(TodoItem(summary="Milk", status=TodoItemStatus.NEEDS_ACTION))
    store = entry.runtime_data
    assert store.open_items[0]["added_by"] == hass_admin_user.name and store.open_items[1]["added_by"] is None


async def test_renaming_onto_another_thing_is_refused(hass, entry):
    entry.runtime_data.add("Milk")
    entry.runtime_data.add("Bread")
    with pytest.raises(ServiceValidationError, match="already on the list"):
        await hass.services.async_call("todo", "update_item", {"item": "Bread", "rename": "milk"},
                                       target={"entity_id": ENTITY}, blocking=True)
