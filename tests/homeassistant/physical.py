"""Opt-in physical trial: a real HA template sensor drives the existing paired camera."""
import asyncio
import json
import logging
from pathlib import Path
import shutil
import tempfile

import aiohttp
from homeassistant import bootstrap, loader
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import CoreState, HomeAssistant

logging.basicConfig(level=logging.WARNING)


async def main():
    # These files are mounted read-only. Never print their contents or flow data.
    token = json.loads(Path('/trial/options.json').read_text())['api_token']
    cameras = json.loads(Path('/trial/cameras.json').read_text())
    camera = next(camera for camera in cameras if camera['id'] == 'pi-camera')
    if camera.get('softwareMotion'):
        raise RuntimeError('Disable software motion detection before testing external sensor forwarding')
    url = 'http://host.docker.internal:8099'
    directory = tempfile.mkdtemp(prefix='hksv-physical-ha-')
    shutil.copytree('/config/custom_components', directory + '/custom_components')
    hass = HomeAssistant(directory)
    loader.async_setup(hass)
    config = {
        'homeassistant': {'name': 'Isolated Camera Trial', 'latitude': 0,
                         'longitude': 0, 'elevation': 0, 'time_zone': 'UTC',
                         'unit_system': 'metric', 'country': 'US'},
        'input_boolean': {'pi_test_motion': {'name': 'Pi test motion', 'initial': False}},
        'template': [{'binary_sensor': [{'name': 'Pi test motion',
            'unique_id': 'hksv_physical_trial_motion', 'device_class': 'motion',
            'state': "{{ is_state('input_boolean.pi_test_motion', 'on') }}"}]}],
    }
    if await bootstrap.async_from_config_dict(config, hass) is not hass:
        raise RuntimeError('HA bootstrap failed')
    run_task = asyncio.create_task(hass.async_run(attach_signals=False))
    entry = None
    try:
        while hass.state is not CoreState.running:
            await asyncio.sleep(0.05)
        async with aiohttp.ClientSession(headers={'Authorization': 'Bearer ' + token}) as session:
            async def engine_camera():
                async with session.get(url + '/v1/status') as response:
                    response.raise_for_status()
                    data = await response.json()
                    return next(item for item in data['cameras'] if item['id'] == camera['id'])

            async def wait_motion(expected):
                async with asyncio.timeout(10):
                    while True:
                        sensor = hass.states.get('binary_sensor.pi_test_motion')
                        actual = await engine_camera()
                        if sensor and sensor.state == ('on' if expected else 'off') and actual['motion'] is expected:
                            return
                        await asyncio.sleep(0.05)

            data = {'engine_url': url, 'api_token': token, 'camera_id': camera['id'],
                    'name': camera['name'], 'rtsp_url': camera['rtspUrl'],
                    'audio': camera.get('audio', False),
                    'max_resolution': camera.get('maxResolution', '1080p'),
                    'motion_entity': 'binary_sensor.pi_test_motion'}
            result = await hass.config_entries.flow.async_init('hksv', context={'source': 'user'}, data=data)
            if result.get('type') != 'form' or result.get('step_id') != 'pair':
                raise RuntimeError('HKSV config flow did not reach pairing step')
            # The accessory is already paired; submitting this step preserves that identity.
            result = await hass.config_entries.flow.async_configure(result['flow_id'], {})
            if result.get('type') != 'create_entry':
                raise RuntimeError('HKSV entry creation failed')
            entry = result['result']
            await hass.async_block_till_done()
            if entry.state is not ConfigEntryState.LOADED:
                raise RuntimeError('HKSV entry did not load')
            await wait_motion(False)
            print('READY: HA integration loaded; real template binary sensor is off; existing camera pairing preserved.', flush=True)
            # Host writes this marker only when the person at the camera is ready.
            async with asyncio.timeout(600):
                while Path('/trial/control/trigger').read_text().strip() != 'run':
                    await asyncio.sleep(0.25)
            async with asyncio.timeout(30):
                while (await engine_camera())['recording'] != 'ready':
                    await asyncio.sleep(0.25)
            await hass.services.async_call('input_boolean', 'turn_on', {'entity_id': 'input_boolean.pi_test_motion'}, blocking=True)
            await wait_motion(True)
            print('PASS: HA helper ON -> template binary sensor ON -> physical camera engine motion ON.', flush=True)
            await asyncio.sleep(8)
            await hass.services.async_call('input_boolean', 'turn_off', {'entity_id': 'input_boolean.pi_test_motion'}, blocking=True)
            await wait_motion(False)
            print('PASS: HA helper OFF -> template binary sensor OFF -> physical camera engine motion OFF.', flush=True)
            await asyncio.sleep(8)
            print('PHYSICAL HA FORWARDING CHECK PASSED. Verify the clip and notification in Apple Home.', flush=True)
    finally:
        try:
            await hass.services.async_call('input_boolean', 'turn_off', {'entity_id': 'input_boolean.pi_test_motion'}, blocking=True)
            await hass.async_block_till_done()
            if entry:
                await hass.config_entries.async_unload(entry.entry_id)
        finally:
            await hass.async_stop()
            await run_task
            shutil.rmtree(directory)


asyncio.run(main())
