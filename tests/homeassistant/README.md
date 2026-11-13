# Home Assistant integration tests

This suite runs Home Assistant 2026.9.1 from its official container image alongside
the real HKSV engine. The harness uses HA's bootstrap, config-flow manager, entity
platforms, service registry, and state machine. It does not mock Home Assistant or
the engine API. It does not drive a browser or test HA OS Supervisor installation.

From the repository root:

```sh
docker compose -p hksv-ha-test -f tests/homeassistant/compose.yaml up --build --abort-on-container-exit --exit-code-from ha-tests
docker compose -p hksv-ha-test -f tests/homeassistant/compose.yaml down --volumes
```

Use a fresh run for repeatability. Each HA process creates a new temporary config
directory, and engine data is on tmpfs. No host ports, real configuration directories,
or Docker socket are exposed to the test services. The hardcoded API token belongs
only to this isolated test environment.

Coverage includes camera setup/pairing forms, the generated camera's motion button,
binary-sensor motion forwarding and unavailable states, brief motion pulses while
a prior API request is delayed, the video resolution option, duplicate configuration,
and unload/reload behavior. Camera video and HKSV media have their own engine suite.

## Optional physical camera trial

`physical.py` connects a temporary HA instance in Docker Desktop to the native engine at
`host.docker.internal:8099`. It uses the configured `pi-camera` and preserves its
Home pairing. Start the [native engine](../../docs/development.md#run-a-native-test)
first, add an RTSP camera without software motion detection, pair it, and enable
Stream & Allow Recording, Any Motion, and Activity Notifications in Home. Keep
the engine host awake throughout the trial. The compose suite above builds the
test image.

From the repository root, initialize the trigger before each run:

```sh
mkdir -p data/mac-test/ha-trial
printf 'waiting\n' > data/mac-test/ha-trial/trigger
docker run --rm --name hksv-physical-ha-trial --entrypoint python3 \
  --mount "type=bind,src=$PWD/tests/homeassistant/physical.py,dst=/trial/run.py,readonly" \
  --mount "type=bind,src=$PWD/custom_components,dst=/config/custom_components,readonly" \
  --mount "type=bind,src=$PWD/data/mac-test/options.json,dst=/trial/options.json,readonly" \
  --mount "type=bind,src=$PWD/data/mac-test/cameras.json,dst=/trial/cameras.json,readonly" \
  --mount "type=bind,src=$PWD/data/mac-test/ha-trial,dst=/trial/control,readonly" \
  hksv-ha-test-ha-tests:latest /trial/run.py
```

After `READY` appears, put visible movement in the camera view and run this in a
second terminal from the repository root within ten minutes:

```sh
printf 'run\n' > data/mac-test/ha-trial/trigger
```

The trial turns an HA input boolean on for eight seconds and verifies its template
binary sensor and the engine's motion state both turn on, then off. It unloads
the integration and removes its temporary container when finished. It publishes
no ports and mounts no production HA configuration or Docker socket. Its API
access can change the test camera's configuration and motion state; use only the
dedicated native trial files shown above. A forwarding pass does not establish
that Home saved a clip or delivered a notification: check both on the phone.
