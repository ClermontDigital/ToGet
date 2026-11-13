"""The list's own rules: adding, the remembered places, ticking off, clearing and the limits."""
from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.to_get import store as store_module
from custom_components.to_get.const import DOMAIN, MAX_PLACE, MAX_SUMMARY
from custom_components.to_get.store import MISSING, InvalidItem, NotFound, ToGetStore, fold


def make(hass) -> ToGetStore:
    return ToGetStore(hass, "test")


async def test_add_cleans_the_text(hass):
    s = make(hass)
    item, how = s.add("  Screws   40 mm ", "  Bunnings ", "  long ones\nfor the deck  ", by="Steve")
    assert how == "added"
    assert item["summary"] == "Screws 40 mm" and item["place"] == "Bunnings" and item["notes"] == "long ones\nfor the deck"
    assert item["status"] == "needs_action" and item["added_by"] == "Steve" and item["done"] is None


@pytest.mark.parametrize("summary", ["", "   ", None])
async def test_add_needs_a_name(hass, summary):
    with pytest.raises(InvalidItem, match="Say what's needed"):
        make(hass).add(summary)


async def test_lengths_are_limited(hass):
    s = make(hass)
    with pytest.raises(InvalidItem, match="up to"):
        s.add("x" * (MAX_SUMMARY + 1))
    with pytest.raises(InvalidItem, match="place"):
        s.add("Milk", "y" * (MAX_PLACE + 1))
    s.add("x" * MAX_SUMMARY, "y" * MAX_PLACE)


async def test_the_same_thing_is_not_added_twice(hass):
    s = make(hass)
    first, _ = s.add("Milk")
    again, how = s.add(" milk ", "Woolies", "2 L")
    assert how == "already" and again is first
    assert first["place"] == "Woolies" and first["notes"] == "2 L"
    assert len(s.items) == 1
    # An empty place or notes doesn't wipe what's there.
    s.add("MILK", "", "")
    assert first["place"] == "Woolies" and first["notes"] == "2 L"


async def test_a_got_thing_goes_back_on_with_its_place(hass):
    s = make(hass)
    item, _ = s.add("Silicone", "Bunnings", "clear")
    s.add("Milk")
    s.update(item["uid"], done=True, by="Ems")
    assert item["status"] == "completed" and item["done_by"] == "Ems" and item["done"]
    back, how = s.add("silicone")
    assert how == "reopened" and back["uid"] == item["uid"]
    assert back["status"] == "needs_action" and back["done"] is None
    assert back["place"] == "Bunnings" and back["notes"] == "clear" and back["summary"] == "silicone"
    assert [i["summary"] for i in s.open_items] == ["Milk", "silicone"]   # back at the end


async def test_reopening_can_change_or_clear_the_place(hass):
    s = make(hass)
    item, _ = s.add("Silicone", "Bunnings")
    s.update(item["uid"], done=True)
    back, _ = s.add("Silicone", "")
    assert back["place"] == ""


async def test_new_things_take_the_place_they_came_from_last(hass):
    s = make(hass)
    item, _ = s.add("Dog food", "Produce store")
    s.update(item["uid"], done=True)
    s.clear_got()
    assert s.items == []
    again, how = s.add("dog food")
    assert how == "added" and again["place"] == "Produce store"
    # Given a place, or told there's none, it's used instead.
    s.remove([again["uid"]])
    assert s.add("Dog food", "")[0]["place"] == ""


async def test_place_is_remembered_from_an_edit(hass):
    s = make(hass)
    item, _ = s.add("Fuel filter")
    s.update(item["uid"], place="Repco")
    s.remove([item["uid"]])
    assert s.add("Fuel filter")[0]["place"] == "Repco"
    assert {"name": "Fuel filter", "place": "Repco"} in s.names()


async def test_update_fields_and_put_back(hass):
    s = make(hass)
    item, _ = s.add("Milk")
    s.update(item["uid"], summary=" Milk  2 L ", place="Woolies", notes="full cream")
    assert item["summary"] == "Milk 2 L" and item["place"] == "Woolies" and item["notes"] == "full cream"
    s.update(item["uid"], done=True)
    when = item["done"]
    s.update(item["uid"], done=True)
    assert item["done"] == when   # ticking twice doesn't change when it was got
    s.update(item["uid"], done=False)
    assert item["status"] == "needs_action" and item["done"] is None
    with pytest.raises(InvalidItem):
        s.update(item["uid"], summary="  ")
    with pytest.raises(NotFound):
        s.update("nope", done=True)


async def test_remove_clear_and_move(hass):
    s = make(hass)
    a, _ = s.add("A")
    b, _ = s.add("B")
    c, _ = s.add("C")
    s.move(c["uid"], None)
    assert [i["summary"] for i in s.items] == ["C", "A", "B"]
    s.move(c["uid"], b["uid"])
    assert [i["summary"] for i in s.items] == ["A", "B", "C"]
    s.move(a["uid"], a["uid"])
    assert [i["summary"] for i in s.items] == ["A", "B", "C"]
    with pytest.raises(NotFound):
        s.move(a["uid"], "nope")
    s.update(b["uid"], done=True)
    assert s.clear_got() == 1
    assert s.remove([a["uid"], "nope"]) == 1
    assert [i["summary"] for i in s.items] == ["C"]


async def test_places_busiest_first_then_remembered(hass):
    s = make(hass)
    old, _ = s.add("Hose fitting", "Bunnings")
    s.remove([old["uid"]])
    s.add("Milk", "Woolies")
    s.add("Bread", "woolies")
    s.add("Pump filter", "Online")
    s.add("Eggs")
    assert s.places() == ["Woolies", "Online", "Bunnings"]


async def test_limits_on_open_got_and_remembered(hass, monkeypatch):
    monkeypatch.setattr(store_module, "MAX_OPEN", 3)
    monkeypatch.setattr(store_module, "MAX_GOT", 2)
    monkeypatch.setattr(store_module, "MAX_KNOWN", 4)
    s = make(hass)
    items = [s.add(n)[0] for n in "ABC"]
    with pytest.raises(InvalidItem, match="full"):
        s.add("D")
    for i in items:
        s.update(i["uid"], done=True)
    assert len(s.got_items) == 2 and "A" not in [i["summary"] for i in s.got_items]   # the oldest got goes
    for n in "DEF":
        s.add(n)
    assert len(s.known) == 4 and fold("A") not in s.known
    # Putting a got thing back counts towards the limit too.
    with pytest.raises(InvalidItem, match="full"):
        s.update(s.got_items[0]["uid"], done=False)


async def test_saved_and_loaded(hass, hass_storage, freezer):
    s = make(hass)
    item, _ = s.add("Milk", "Woolies")
    s.update(item["uid"], done=True)
    freezer.tick(timedelta(seconds=2))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    saved = hass_storage[f"{DOMAIN}.test"]["data"]
    assert saved["items"][0]["summary"] == "Milk" and saved["known"]["milk"]["place"] == "Woolies"
    again = make(hass)
    await again.async_load()
    assert again.items == s.items and again.known == s.known


async def test_load_skips_broken_rows(hass, hass_storage):
    hass_storage[f"{DOMAIN}.test"] = {"version": 1, "key": f"{DOMAIN}.test", "data": {
        "items": [{"uid": "a", "summary": "Milk", "status": "needs_action"}, {"summary": "no uid"}, "junk"],
        "known": {"milk": {"name": "Milk"}, "x": "junk"},
    }}
    s = make(hass)
    await s.async_load()
    assert [i["summary"] for i in s.items] == ["Milk"] and list(s.known) == ["milk"]


async def test_missing_is_not_empty(hass):
    s = make(hass)
    item, _ = s.add("Milk", "Woolies", "2 L")
    s.update(item["uid"], place=MISSING, notes=MISSING)
    assert item["place"] == "Woolies" and item["notes"] == "2 L"


async def test_no_doubles_by_renaming_or_putting_back(hass):
    s = make(hass)
    milk, _ = s.add("Milk")
    bread, _ = s.add("Bread")
    with pytest.raises(InvalidItem, match="Milk is already on the list"):
        s.update(bread["uid"], summary="MILK")
    s.update(milk["uid"], done=True)
    s.update(bread["uid"], summary="Milk")     # fine now: the other Milk has been got
    with pytest.raises(InvalidItem, match="already on the list"):
        s.update(milk["uid"], done=False)
    s.update(milk["uid"], summary="Milk", place="Woolies")   # changing a got one is fine


async def test_a_renamed_typo_is_forgotten(hass):
    s = make(hass)
    item, _ = s.add("Silicne", "Bunings")
    s.update(item["uid"], summary="Silicone", place="Bunnings")
    assert [n["name"] for n in s.names()] == ["Silicone"]
    assert s.places() == ["Bunnings"]
