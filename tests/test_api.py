"""The card's WebSocket API."""
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.to_get.const import DOMAIN


async def call(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_lists(hass, entry, hass_ws_client):
    entry.runtime_data.add("Milk")
    client = await hass_ws_client(hass)
    msg = await call(client, type="to_get/lists")
    assert msg["result"] == [{"entry_id": entry.entry_id, "name": "To get", "icon": "mdi:cart-outline",
                              "count": 1, "first": ["Milk"]}]


async def test_subscribe_add_tick_and_clear(hass, entry, hass_ws_client, hass_admin_user):
    client = await hass_ws_client(hass)
    sub = await call(client, type="to_get/subscribe", entry_id=entry.entry_id)
    assert sub["success"]
    first = (await client.receive_json())["event"]
    assert first["items"] == [] and first["got"] == [] and first["can_change"] is True
    assert first["list"]["name"] == "To get"

    added = await call(client, type="to_get/add", entry_id=entry.entry_id, summary="Silicone", place="Bunnings")
    # The subscription's event comes before the answer.
    assert added["type"] == "event" and added["event"]["items"][0]["summary"] == "Silicone"
    added = await client.receive_json()
    assert added["success"] and added["result"]["how"] == "added"
    item = added["result"]["item"]
    assert item["place"] == "Bunnings" and item["added_by"] == hass_admin_user.name

    await client.send_json_auto_id({"type": "to_get/update", "entry_id": entry.entry_id, "uid": item["uid"], "done": True})
    event = (await client.receive_json())["event"]
    assert event["items"] == [] and event["got"][0]["uid"] == item["uid"] and event["places"] == ["Bunnings"]
    assert (await client.receive_json())["result"]["status"] == "completed"

    await client.send_json_auto_id({"type": "to_get/clear", "entry_id": entry.entry_id})
    event = (await client.receive_json())["event"]
    assert event["got"] == [] and event["names"] == [{"name": "Silicone", "place": "Bunnings"}]
    assert (await client.receive_json())["result"] == {"removed": 1}


async def test_add_without_a_place_uses_the_remembered_one(hass, entry, hass_ws_client):
    item, _ = entry.runtime_data.add("Dog food", "Produce store")
    entry.runtime_data.remove([item["uid"]])
    client = await hass_ws_client(hass)
    msg = await call(client, type="to_get/add", entry_id=entry.entry_id, summary="Dog food")
    assert msg["result"]["item"]["place"] == "Produce store"
    msg = await call(client, type="to_get/add", entry_id=entry.entry_id, summary="Cat food", place="")
    assert msg["result"]["item"]["place"] == ""


async def test_update_remove_and_errors(hass, entry, hass_ws_client):
    item, _ = entry.runtime_data.add("Milk")
    client = await hass_ws_client(hass)
    msg = await call(client, type="to_get/update", entry_id=entry.entry_id, uid=item["uid"], summary="Milk 2 L",
                     place="Woolies", notes="full cream")
    assert msg["result"]["summary"] == "Milk 2 L" and msg["result"]["notes"] == "full cream"
    msg = await call(client, type="to_get/update", entry_id=entry.entry_id, uid=item["uid"], summary=" ")
    assert msg["error"]["code"] == "invalid_format" and msg["error"]["message"] == "Say what's needed"
    msg = await call(client, type="to_get/update", entry_id=entry.entry_id, uid="nope", done=True)
    assert msg["error"]["code"] == "not_found"
    msg = await call(client, type="to_get/add", entry_id=entry.entry_id, summary="")
    assert msg["error"]["code"] == "invalid_format"
    msg = await call(client, type="to_get/remove", entry_id=entry.entry_id, uids=[item["uid"]])
    assert msg["result"] == {"removed": 1}
    msg = await call(client, type="to_get/add", entry_id="nope", summary="Milk")
    assert msg["error"]["code"] == "not_found"
    msg = await call(client, type="to_get/subscribe", entry_id="nope")
    assert msg["error"]["code"] == "not_found"


async def test_read_only_users_can_look_but_not_change(hass, entry, hass_ws_client, hass_read_only_access_token):
    entry.runtime_data.add("Milk")
    client = await hass_ws_client(hass, hass_read_only_access_token)
    assert (await call(client, type="to_get/lists"))["success"]
    await client.send_json_auto_id({"type": "to_get/subscribe", "entry_id": entry.entry_id})
    assert (await client.receive_json())["success"]
    assert (await client.receive_json())["event"]["can_change"] is False
    for msg in ({"type": "to_get/add", "summary": "Bread"}, {"type": "to_get/clear"},
                {"type": "to_get/remove", "uids": []},
                {"type": "to_get/update", "uid": entry.runtime_data.items[0]["uid"], "done": True}):
        reply = await call(client, entry_id=entry.entry_id, **msg)
        assert reply["error"]["code"] == "unauthorized", reply
    assert len(entry.runtime_data.open_items) == 1


async def test_summary_counts_every_list(hass, entry, hass_ws_client):
    other = MockConfigEntry(domain=DOMAIN, title="Hardware", data={"name": "Hardware"}, options={"icon": "mdi:hammer"})
    other.add_to_hass(hass)
    assert await hass.config_entries.async_setup(other.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "to_get/subscribe_summary"})
    assert (await client.receive_json())["success"]
    assert (await client.receive_json())["event"]["total"] == 0

    other.runtime_data.add("Screws")
    event = (await client.receive_json())["event"]
    assert event["total"] == 1 and [x["count"] for x in event["lists"]] == [0, 1]
    assert event["lists"][1]["first"] == ["Screws"]

    # One list only.
    await client.send_json_auto_id({"type": "to_get/subscribe_summary", "entry_id": entry.entry_id})
    assert (await client.receive_json())["success"]
    event = (await client.receive_json())["event"]
    assert event["total"] == 0 and [x["name"] for x in event["lists"]] == ["To get"]


async def test_a_list_going_away_is_told(hass, entry, hass_ws_client):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "to_get/subscribe", "entry_id": entry.entry_id})
    await client.receive_json()
    await client.receive_json()
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert (await client.receive_json())["event"] == {"gone": True}
    # Set up again (a reload): the same subscription gets the list straight away, and carries on.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    event = (await client.receive_json())["event"]
    assert event["items"] == [] and event["list"]["name"] == "To get"
    entry.runtime_data.add("Milk")
    event = (await client.receive_json())["event"]
    assert event["items"][0]["summary"] == "Milk"
    assert (await call(client, type="to_get/lists"))["result"][0]["count"] == 1


async def test_card_is_served(hass, entry, hass_client):
    client = await hass_client()
    resp = await client.get("/to_get/to-get-card.js")
    assert resp.status == 200
    assert "to-get-card" in await resp.text()
