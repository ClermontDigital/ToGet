"""The to_get.add action: like Home Assistant's todo.add_item, with where the thing is coming from."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components.todo import DOMAIN as TODO_DOMAIN
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import service

from .const import ATTR_ITEM, ATTR_NOTES, ATTR_PLACE, DOMAIN, MAX_NOTES, MAX_PLACE, MAX_SUMMARY, SERVICE_ADD

ADD_SCHEMA = {
    vol.Required(ATTR_ITEM): vol.All(cv.string, vol.Length(min=1, max=MAX_SUMMARY)),
    vol.Optional(ATTR_PLACE): vol.All(cv.string, vol.Length(max=MAX_PLACE)),
    vol.Optional(ATTR_NOTES): vol.All(cv.string, vol.Length(max=MAX_NOTES)),
}


@callback
def async_register_services(hass: HomeAssistant) -> None:
    service.async_register_platform_entity_service(
        hass, DOMAIN, SERVICE_ADD, entity_domain=TODO_DOMAIN, schema=ADD_SCHEMA, func="async_add_with_place",
    )
