"""A motion simulator for the generated test camera."""
import asyncio
import logging

import aiohttp
from homeassistant.components.button import ButtonEntity
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_call_later

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry, async_add_entities):
    if entry.data["rtsp_url"] == "test://pattern":
        async_add_entities([TestMotionButton(entry)])


class TestMotionButton(ButtonEntity):
    _attr_has_entity_name = True
    _attr_name = "Simulate motion"
    _attr_icon = "mdi:motion-sensor"

    def __init__(self, entry):
        self._entry = entry
        self._attr_unique_id = entry.entry_id + "_test_motion"
        self._attr_device_info = {
            "identifiers": {("hksv", entry.entry_id)},
            "name": entry.data["name"], "manufacturer": "HA HKSV", "model": "Test Camera",
        }
        self._cancel_timer = None

    async def _send(self, active):
        await self._entry.runtime_data.request(
            "POST", f"/v1/cameras/{self._entry.data['camera_id']}/motion", {"active": active},
        )

    async def _clear(self, _now=None):
        self._cancel_timer = None
        try:
            await self._send(False)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            _LOGGER.warning("Could not reset test motion; use the engine API to clear it")

    async def async_press(self):
        try:
            await self._send(True)
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise HomeAssistantError("HKSV engine unavailable") from err
        if self._cancel_timer:
            self._cancel_timer()
        self._cancel_timer = async_call_later(self.hass, 8, self._clear)

    async def async_will_remove_from_hass(self):
        if self._cancel_timer:
            self._cancel_timer()
            await self._clear()
