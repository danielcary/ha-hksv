"""Exercise the integration in real Home Assistant against the real engine."""
import asyncio
import logging
import os
import shutil
import tempfile

import aiohttp
from homeassistant.core import HomeAssistant, CoreState
from homeassistant import bootstrap, loader
from homeassistant.config_entries import ConfigEntries, ConfigEntryState
from homeassistant.setup import async_setup_component

logging.basicConfig(level=logging.WARNING)


async def main():
    config_dir = tempfile.mkdtemp(prefix='hksv-ha-')
    shutil.copytree('/config/custom_components', config_dir + '/custom_components')
    hass = HomeAssistant(config_dir)
    loader.async_setup(hass)
    config = {'homeassistant': {'name': 'HKSV Test', 'latitude': 0, 'longitude': 0, 'elevation': 0, 'time_zone': 'UTC', 'unit_system': 'metric', 'country': 'US'}}
    assert await bootstrap.async_from_config_dict(config, hass) is hass
    run_task = asyncio.create_task(hass.async_run(attach_signals=False))
    while hass.state is not CoreState.running:
        await asyncio.sleep(0.01)
    try:
        async with aiohttp.ClientSession() as session:
            async def status():
                async with session.get(os.environ['HKSV_ENGINE_URL'] + '/v1/status', headers={'Authorization': 'Bearer ' + os.environ['HKSV_API_TOKEN']}) as response:
                    response.raise_for_status()
                    return await response.json()

            async def motion_is(camera_id, expected):
                async with asyncio.timeout(5):
                    while True:
                        data = await status()
                        if any(c['id'] == camera_id and c['motion'] is expected for c in data['cameras']):
                            return
                        await asyncio.sleep(0.05)

            async def add_camera(camera_id, motion_entity=None):
                result = await hass.config_entries.flow.async_init('hksv', context={'source': 'user'})
                assert result['type'] == 'form', result
                data = {'engine_url': os.environ['HKSV_ENGINE_URL'], 'api_token': os.environ['HKSV_API_TOKEN'], 'camera_id': camera_id, 'name': camera_id.replace('-', ' ').title(), 'rtsp_url': 'test://pattern'}
                if motion_entity:
                    data['motion_entity'] = motion_entity
                result = await hass.config_entries.flow.async_configure(result['flow_id'], data)
                assert result['type'] == 'form' and result['step_id'] == 'pair', result
                assert len(result['description_placeholders']['pairing_code']) == 10
                result = await hass.config_entries.flow.async_configure(result['flow_id'], {})
                assert result['type'] == 'create_entry', result
                entry = result['result']
                await hass.async_block_till_done()
                assert entry.state is ConfigEntryState.LOADED, entry.state
                return entry, data

            button_entry, button_data = await add_camera('button-camera')
            buttons = hass.states.async_all('button')
            assert len(buttons) == 1, buttons
            await hass.services.async_call('button', 'press', {'entity_id': buttons[0].entity_id}, blocking=True)
            await motion_is('button-camera', True)
            await asyncio.sleep(8.5)
            await motion_is('button-camera', False)
            print('PASS: config flow, pairing step, real button service, and automatic motion reset', flush=True)

            # Change the resolution through the same Configure form the UI opens.
            async def button_quality():
                return next(c for c in (await status())['cameras'] if c['id'] == 'button-camera')['maxResolution']

            assert await button_quality() == '1080p'
            quality_form = await hass.config_entries.options.async_init(button_entry.entry_id)
            assert quality_form['type'] == 'form', quality_form
            result = await hass.config_entries.options.async_configure(quality_form['flow_id'], {'max_resolution': '720p'})
            assert result['type'] == 'create_entry', result
            await hass.async_block_till_done()
            assert button_entry.state is ConfigEntryState.LOADED, button_entry.state
            assert await button_quality() == '720p'
            print('PASS: Configure changes the existing camera to 720p', flush=True)

            hass.states.async_set('binary_sensor.camera_motion', 'off', {'device_class': 'motion'})
            sensor_entry, sensor_data = await add_camera('sensor-camera', 'binary_sensor.camera_motion')
            await motion_is('sensor-camera', False)
            hass.states.async_set('binary_sensor.camera_motion', 'on')
            await motion_is('sensor-camera', True)
            hass.states.async_set('binary_sensor.camera_motion', 'off')
            await motion_is('sensor-camera', False)
            hass.states.async_set('binary_sensor.camera_motion', 'on')
            await motion_is('sensor-camera', True)
            hass.states.async_set('binary_sensor.camera_motion', 'unavailable')
            await motion_is('sensor-camera', False)
            print('PASS: HA binary-sensor on/off and unavailable state reach the real engine', flush=True)

            # Instrument successful real requests, delaying the first to simulate latency.
            client = sensor_entry.runtime_data
            original_request = client.request
            gate, in_flight = asyncio.Event(), asyncio.Event()
            delivered = []

            async def observe_request(method, path, data=None):
                if path.endswith('/motion') and not gate.is_set():
                    in_flight.set()
                    await gate.wait()
                response = await original_request(method, path, data)
                if path.endswith('/motion'):
                    delivered.append(data['active'])
                return response

            client.request = observe_request
            try:
                hass.states.async_set('binary_sensor.camera_motion', 'off')
                async with asyncio.timeout(5):
                    await in_flight.wait()
                hass.states.async_set('binary_sensor.camera_motion', 'on')
                hass.states.async_set('binary_sensor.camera_motion', 'off')
                gate.set()
                await hass.async_block_till_done()
                assert delivered == [False, True, False], delivered
            finally:
                gate.set()
                client.request = original_request
            print('PASS: brief motion pulse survives an in-flight API request', flush=True)

            result = await hass.config_entries.flow.async_init('hksv', context={'source': 'user'}, data=sensor_data)
            assert result['type'] == 'abort' and result['reason'] == 'already_configured', result
            print('PASS: duplicate camera rejected', flush=True)

            assert await hass.config_entries.async_unload(sensor_entry.entry_id)
            hass.states.async_set('binary_sensor.camera_motion', 'on')
            await hass.async_block_till_done()
            await motion_is('sensor-camera', False)
            assert await hass.config_entries.async_setup(sensor_entry.entry_id)
            await hass.async_block_till_done()
            await motion_is('sensor-camera', True)
            print('PASS: unload removes listener; reload resynchronizes current motion', flush=True)

            assert await hass.config_entries.async_unload(button_entry.entry_id)
            assert await hass.config_entries.async_unload(sensor_entry.entry_id)
            print('ALL HOME ASSISTANT INTEGRATION CHECKS PASSED', flush=True)
    finally:
        await hass.async_stop()
        await run_task

asyncio.run(main())
