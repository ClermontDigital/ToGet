"""Adding a list, and its options."""
from homeassistant.data_entry_flow import FlowResultType

from custom_components.to_get.const import DOMAIN


async def test_add_a_list(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "  To   get ", "icon": "mdi:cart"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "To get" and result["options"] == {"icon": "mdi:cart"}
    await hass.async_block_till_done()
    assert hass.states.get("todo.to_get").state == "0"


async def test_names_must_be_given_and_different(hass, entry):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "   "})
    assert result["errors"] == {"name": "name_required"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "TO GET"})
    assert result["errors"] == {"name": "name_taken"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "Hardware"})
    assert result["type"] is FlowResultType.CREATE_ENTRY and result["options"] == {"icon": "mdi:cart-outline"}


async def test_options_change_the_icon(hass, entry):
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"icon": "mdi:basket"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert hass.states.get("todo.to_get").attributes["icon"] == "mdi:basket"
