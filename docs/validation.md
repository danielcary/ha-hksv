# Validation

## Automated checks

- The Linux engine suite passed all 23 tests. Coverage includes a real RTSP
  publisher, video-based motion and recording, H.264 and AAC decoding, encrypted
  live video and Opus audio, mute controls, pairing identity persistence, and
  advertised resolution limits for live view and recordings.
- The Home Assistant Container suite passed setup, pairing instructions,
  resolution changes through **Configure**, simulated motion, external motion
  sensor forwarding, short pulses, and integration reload.

The [developer guide](development.md) shows how to repeat these tests. The tests
exercise the engine and Home Assistant Core. They do not exercise Supervisor
installation or Apple's end-to-end pairing and iCloud recording behavior.

## Physical camera checks

A single RTSP camera on a local test network confirmed pairing, snapshots, and
live video in Apple Home. A microphone was audible in both live view and a saved
HKSV clip. A Home Assistant template sensor and the engine's video detector each
triggered a playable recording and an activity notification in separate trials.

The resolution control was verified in Home Assistant Container. A separate
source quality trial produced 720p RTSP video with audio, but the test camera
reported frame errors in that mode. Source quality and reliability depend on
camera hardware, encoding settings, and the network.

Remaining checks include installation on Home Assistant OS, sustained operation,
recovery after camera or host restarts, pre-event and post-event coverage, and
compatibility across more cameras.
