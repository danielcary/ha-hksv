"""Configure the engine and forward HA motion state. No camera entities yet."""
import asyncio
from datetime import timedelta
import logging

import aiohttp
from homeassistant.const import Platform
from homeassistant.core import Event
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from .api import EngineClient, camera_payload

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry):
    data = entry.data
    client = EngineClient(async_get_clientsession(hass), data["engine_url"], data["api_token"])
    try:
        await client.request("POST", "/v1/cameras", camera_payload(data, entry.options))
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        raise ConfigEntryNotReady("HKSV engine unavailable") from err
    entry.runtime_data = client
    lock = asyncio.Lock()

    async def sync_motion(_event=None):
        # Preserve the event's state before waiting for an earlier HTTP request.
        # Reading the live state after acquiring the lock can erase brief pulses.
        state = (
            _event.data.get("new_state")
            if isinstance(_event, Event)
            else hass.states.get(data.get("motion_entity", ""))
        )
        # Unknown/unavailable clears stale motion rather than holding it active.
        active = state is not None and state.state == "on"
        async with lock:
            try:
                await client.request("POST", f"/v1/cameras/{data['camera_id']}/motion", {"active": active})
            except (aiohttp.ClientError, asyncio.TimeoutError):
                _LOGGER.warning("HKSV motion sync failed; will retry")

    if data.get("motion_entity"):
        entry.async_on_unload(async_track_state_change_event(hass, [data["motion_entity"]], sync_motion))
        entry.async_on_unload(async_track_time_interval(hass, sync_motion, timedelta(seconds=30)))
        await sync_motion()
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.BUTTON])
    return True


async def async_unload_entry(hass, entry):
    return await hass.config_entries.async_unload_platforms(entry, [Platform.BUTTON])
