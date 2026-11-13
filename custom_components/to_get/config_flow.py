"""Config flow: one entry per list. Most homes need one; more (hardware, online orders) are fine too."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import CONF_ICON, CONF_NAME, DEFAULT_ICON, DEFAULT_NAME, DOMAIN


class ToGetConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            name = " ".join(user_input[CONF_NAME].split())
            if not name:
                errors[CONF_NAME] = "name_required"
            elif any(e.title.casefold() == name.casefold() for e in self._async_current_entries()):
                errors[CONF_NAME] = "name_taken"
            else:
                return self.async_create_entry(title=name, data={CONF_NAME: name},
                                               options={CONF_ICON: user_input.get(CONF_ICON) or DEFAULT_ICON})
        current = user_input or {}
        default_name = DEFAULT_NAME if not self._async_current_entries() else ""
        schema = vol.Schema({
            vol.Required(CONF_NAME, default=current.get(CONF_NAME, default_name)): str,
            vol.Optional(CONF_ICON, default=current.get(CONF_ICON, DEFAULT_ICON)): selector.IconSelector(),
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return ToGetOptionsFlow()


class ToGetOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={CONF_ICON: user_input.get(CONF_ICON) or DEFAULT_ICON})
        current = self.config_entry.options.get(CONF_ICON) or DEFAULT_ICON
        return self.async_show_form(step_id="init", data_schema=vol.Schema({
            vol.Optional(CONF_ICON, default=current): selector.IconSelector(),
        }))
