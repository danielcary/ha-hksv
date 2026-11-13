# Develop and test HA HKSV

Home Assistant manages configuration and can forward motion from a binary
sensor. The engine reads RTSP directly, sends live media to Apple Home, and
hands recordings to the home hub. Its optional video detector runs in the engine.

## Run a native test

Install Node.js 22 or 24 and FFmpeg with `libx264`, `libopus`, AAC, and SRTP
support. From `addon/engine/`:

```sh
npm ci
npm run build
npm run native -- start
```

In another terminal in the same folder:

```sh
npm run native -- add-camera test://pattern
npm run native -- pairing
npm run native -- status
```

The pairing command prints a code and saves a QR image. Add the camera in Apple
Home. With recording allowed and the status `ready`, run
`npm run native -- motion` to send eight seconds of motion. To use a physical
camera, replace `test://pattern` with its RTSP URL. Add `--audio` to use its
microphone and `--software-motion` for video motion detection. `add-camera`
updates the helper's existing camera if run again.

The helper stores credentials and pairing data in `data/mac-test/`. Keep that
folder private and preserve it to reuse the pairing. Stop the engine with
Ctrl+C. The host needs to stay awake and reachable for Apple Home testing.

## Run the automated tests

From the repository root:

```sh
docker build --target tests -t ha-hksv-tests addon
docker run --rm ha-hksv-tests

docker compose -p hksv-ha-test -f tests/homeassistant/compose.yaml up --build --abort-on-container-exit --exit-code-from ha-tests
docker compose -p hksv-ha-test -f tests/homeassistant/compose.yaml down --volumes
```

The engine test image includes FFmpeg and a MediaMTX RTSP fixture. Run `npm test`
from `addon/engine/` for native tests. Native runs skip cases when required tools
or container fixtures are unavailable. See [Home Assistant integration tests](../tests/homeassistant/README.md)
for the separate integration harness and an optional physical trial.

To build the production image, run `docker build --target production -t ha-hksv addon`.
The production image needs persistent `/data` storage and a token of at least 32
characters, either in `/data/options.json` as `api_token` or in `HKSV_API_TOKEN`.
Use host networking on Linux for HomeKit discovery and media. Docker Desktop port
forwarding is useful for development, but does not reproduce the HomeKit network
setup. `HKSV_HOMEKIT_INTERFACE` can restrict advertisement to a network interface.
`HKSV_FFMPEG_PATH` overrides the FFmpeg executable.

## Engine API

The engine listens on `127.0.0.1:8099` by default. Every request requires
`Authorization: Bearer <token>`. `HKSV_BIND_ADDRESS` can change the listening
address. Keep the API on a trusted network since it uses HTTP.

| Request | Behavior |
| --- | --- |
| `GET /v1/status` | Capabilities and camera status without RTSP credentials. |
| `POST /v1/cameras` | Add or update a camera with the JSON fields below. |
| `GET /v1/cameras/front/pairing` | Pairing code, setup URI, and QR SVG. Treat the response as a credential. |
| `POST /v1/cameras/front/motion` | Set the external motion state with `{"active": true}` or `{"active": false}`. |

Example camera configuration:

```json
{
  "id": "front",
  "name": "Front Camera",
  "rtspUrl": "rtsp://camera.example/stream",
  "audio": true,
  "softwareMotion": true,
  "maxResolution": "720p"
}
```

Audio and software motion default to off. Maximum resolution defaults to 1080p.
Configuration is saved before the engine publishes the accessory. If publication
fails, fix the cause and retry the same configuration. Unchanged configuration
keeps the current camera running. The engine stores RTSP URLs and pairing data
with restrictive permissions and depends on the host to protect them at rest.

See [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) and the
[FFmpeg format documentation](https://ffmpeg.org/ffmpeg-formats.html) for the
underlying HomeKit and media components.
