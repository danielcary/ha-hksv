# HA HKSV Engine (Development)

Set `api_token` to a random token of at least 32 characters before starting.
Install the accompanying `custom_components/hksv` integration, then connect to
`http://127.0.0.1:8099` with the same token.

To try the bridge without a camera, use `test://pattern` as the video URL and leave
the motion sensor empty. The integration displays a HomeKit pairing code and adds
a **Simulate motion** button. Each press signals eight seconds of motion.

HomeKit live video and recording are experimental. Use a complete RTSP URL for a
physical camera. Turn on **Forward camera microphone audio** in the integration if
the feed includes audio, then turn on **Record Audio** in Apple Home to include it
in recordings. ONVIF discovery is not implemented.

For a camera without a separate motion sensor, enable **Detect motion in the
camera video** and leave **Motion sensor** empty. The bridge uses changes between
video frames to trigger recordings.

Use **Maximum Apple Home resolution** when adding a camera or choose
**Configure** on its integration entry to change it later. This caps live view
and recordings. Set the source resolution on the camera or its RTSP publisher.

The app uses host networking for HomeKit discovery. Its management API listens
on loopback. Pairing and camera configuration are persisted in `/data`; protect
backups because they contain credentials. The [HA HKSV repository](https://github.com/danielcary/ha-hksv)
has installation steps, limitations, and a developer guide.
