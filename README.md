# HA HKSV

HA HKSV connects an RTSP camera to Apple Home as a HomeKit camera with live video,
optional microphone audio, and motion-triggered HomeKit Secure Video (HKSV)
recordings. The Home Assistant integration configures the bridge and can forward
motion from a binary sensor. The engine can also detect movement in the video.

This is experimental. Live view, audio, recordings, and notifications have worked
in a physical camera trial. Start with one camera. See [validation](docs/validation.md)
for what has been tested.

## Install on Home Assistant OS

You need Home Assistant OS on **64-bit ARM (`aarch64`) or x86-64 (`amd64`)**, and
an Apple Home setup on the local network. Recording requires a compatible Apple
home hub and iCloud+. [Apple's HKSV setup guide](https://support.apple.com/guide/icloud/mm7c90d21583/icloud)

### Install the engine from the repository URL

[![Add the HA HKSV repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fdanielcary%2Fha-hksv)

1. In Home Assistant, open **Settings → Apps → Install app → ⋮ → Repositories**.
   Older releases call **Apps** **Add-ons**.
2. Paste `https://github.com/danielcary/ha-hksv` and select **Add**.
3. Under **HA HKSV** in the app store, select **HA HKSV Engine (Development)**
   and choose **Install**. Home Assistant builds the engine on your device.
4. In the engine app's **Configuration** tab, set `api_token` to a random value
   of at least 32 characters. For example, generate one with
   `openssl rand -hex 32`. Save and start the app. If startup fails, check its
   **Log** tab.

### Install the Home Assistant integration

The repository URL installs the engine app. The integration is a separate step.

1. Download this repository and copy `custom_components/hksv/` to
   `/config/custom_components/hksv/` on Home Assistant. Restart Home Assistant.
2. Open **Settings → Devices & services → Add integration** and select
   **HA HKSV Bridge (Development)**.
3. Enter `http://127.0.0.1:8099` as the **Engine URL** and paste the same token.
   Give the camera a unique ID (for example, `front-camera`) and a display name.
   Enter its full RTSP URL or use `test://pattern` to try it without a camera.

### Manual engine installation

To install the engine from a downloaded copy, put the contents of `addon/` in an
`hksv_engine` folder under Home Assistant's local apps folder (`/local_apps` on
current releases, `/addons` on older releases). In the app store menu, choose
**Check for updates**, then install the engine from **Local apps** and configure
its token as above. [Home Assistant's local app guide](https://contributors.home-assistant.io/apps/first-app/)

## Set up the camera in Apple Home

1. In Apple Home, choose **Add Accessory → More Options**, select the camera, and
   enter the pairing code displayed in Home Assistant. Finish the Home Assistant
   setup form. Each configured camera pairs as a separate accessory.
2. Open the camera in Apple Home to check live video. For recordings, set the
   relevant **When Home** or **When Away** mode to **Stream & Allow Recording**.
   Choose **Any Motion** for the initial test and allow a few seconds for the
   bridge to buffer video.
3. For `test://pattern`, leave both motion settings off and press the generated
   camera's **Simulate motion** button in Home Assistant. For an RTSP camera,
   configure one of the motion sources below, then move through the camera's
   view. Check the Apple Home timeline for a playable clip.
4. To receive alerts, turn on **Activity Notifications** for the camera in
   Apple Home. Home and away rules, time filters, and activity filters can
   affect which alerts appear. [Apple's camera settings guide](https://support.apple.com/guide/iphone/iph7bc5df9d9/ios)

| Home Assistant setting | When to use it |
| --- | --- |
| **Detect motion in the camera video** | Use for an RTSP camera without a separate motion sensor. The engine signals general movement. |
| **Motion sensor** | Select a Home Assistant binary sensor, such as one exposed by a camera integration. Either source can keep motion active if both are enabled. |
| **Forward camera microphone audio** | Enable for an RTSP feed with audio. Also turn on **Record Audio** in Apple Home to include sound in recordings. With `test://pattern`, this setting generates a test tone. |
| **Maximum Apple Home resolution** | Choose 360p, 720p, or 1080p. To change it later, open the integration entry's **Configure** menu. This caps live view and recordings. Apple Home can choose a lower mode, and the original RTSP feed determines the available detail. |

## Limitations

- Installation through Home Assistant OS Supervisor still needs end-to-end
  validation. The integration has been tested in Home Assistant Container, and
  Apple Home pairing and recording were tested with a native engine.
- The engine needs an RTSP URL. Home Assistant can supply a binary sensor through
  ONVIF or another integration. The engine has no camera discovery or ONVIF client.
- Software motion detection compares video frames. Lighting changes, shadows,
  and camera movement can trigger it. Apple Home handles its own activity filters.
- The engine transcodes video in software and can be CPU intensive, especially at
  higher resolutions or with multiple cameras. Hardware acceleration, two-way
  audio, and live resolution changes within a stream are unsupported.
- Recording uses a four-second rolling prebuffer and is capped at two minutes per
  event. Camera compatibility, sustained uptime, and clip timing need wider testing.
- Home Assistant can change the resolution limit after setup. Removing a Home
  Assistant entry does not remove the published camera. Unpair it in Apple Home
  when retiring the accessory.

If pairing fails, check that the engine is running and Apple Home devices can
reach it on the local network. If live view works but no clip appears, check that
recording is allowed for the active mode and that the camera has a motion source.

Keep the engine API on loopback for the Home Assistant OS setup. Treat tokens,
RTSP credentials, and pairing data as secrets. Keep the app's data and backups
private. Preserving that data across upgrades preserves the camera's pairing.

See [development and standalone setup](docs/development.md) for local testing,
container builds, and the engine API.
