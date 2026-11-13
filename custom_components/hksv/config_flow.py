"""Development flow: one config entry per camera."""
import asyncio
import re

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    EntitySelector,
    EntitySelectorConfig,
    SelectSelector,
    SelectSelectorConfig,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from .api import DEFAULT_RESOLUTION, EngineClient, camera_payload

RESOLUTION = SelectSelector(SelectSelectorConfig(options=["360p", "720p", "1080p"]))

SCHEMA = vol.Schema({
    vol.Required("engine_url", default="http://127.0.0.1:8099"): str,
    vol.Required("api_token"): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
    vol.Required("camera_id"): str,
    vol.Required("name"): str,
    vol.Required("rtsp_url"): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
    vol.Optional("audio", default=False): bool,
    vol.Optional("software_motion", default=False): bool,
    vol.Optional("max_resolution", default=DEFAULT_RESOLUTION): RESOLUTION,
    vol.Optional("motion_entity"): EntitySelector(EntitySelectorConfig(domain="binary_sensor")),
})


class HKSVConfigFlow(config_entries.ConfigFlow, domain="hksv"):
    VERSION = 1
    _camera_input = None
    _pairing_code = ""

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return HKSVOptionsFlow()

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                if not re.fullmatch(r"[a-z0-9_-]{1,64}", user_input["camera_id"]):
                    raise ValueError("Invalid camera id")
                client = EngineClient(async_get_clientsession(self.hass), user_input["engine_url"], user_input["api_token"])
                user_input["engine_url"] = client.url
                self._async_abort_entries_match({"engine_url": client.url, "camera_id": user_input["camera_id"]})
                status = await client.request("GET", "/v1/status")
                if not status.get("capabilities", {}).get("configuration"):
                    raise ValueError("Unsupported engine")
                if user_input.get("software_motion") and not status["capabilities"].get("softwareMotion"):
                    raise ValueError("Engine does not support software motion detection")
                await client.request("POST", "/v1/cameras", camera_payload(user_input))
            except (aiohttp.ClientError, asyncio.TimeoutError):
                errors["base"] = "cannot_connect"
            except ValueError:
                errors["base"] = "invalid_config"
            else:
                self._camera_input = user_input
                try:
                    pairing = await client.request("GET", f"/v1/cameras/{user_input['camera_id']}/pairing")
                    self._pairing_code = pairing["pincode"]
                except (aiohttp.ClientError, asyncio.TimeoutError, KeyError):
                    self._pairing_code = "Unavailable; use the engine pairing endpoint after it recovers."
                return await self.async_step_pair()
        return self.async_show_form(step_id="user", data_schema=SCHEMA, errors=errors)

    async def async_step_pair(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(title=self._camera_input["name"], data=self._camera_input)
        return self.async_show_form(
            step_id="pair", data_schema=vol.Schema({}),
            description_placeholders={"pairing_code": self._pairing_code},
        )


class HKSVOptionsFlow(config_entries.OptionsFlowWithReload):
    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(data={**self.config_entry.options, **user_input})
        current = camera_payload(self.config_entry.data, self.config_entry.options)["maxResolution"]
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({vol.Required("max_resolution", default=current): RESOLUTION}),
        )
