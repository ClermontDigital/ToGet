"""Shared fixtures."""
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.to_get.const import DOMAIN

pytest_plugins = ["pytest_homeassistant_custom_component"]


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Make custom_components/to_get loadable in every test."""
    yield


@pytest.fixture
async def entry(hass):
    """A "To get" list, set up."""
    entry = MockConfigEntry(domain=DOMAIN, title="To get", data={"name": "To get"}, options={"icon": "mdi:cart-outline"})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
