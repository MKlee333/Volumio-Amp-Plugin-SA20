# ARCAM SA20 Volumio Plugin

This plugin runs inside Volumio and controls the ARCAM SA20 over TCP/IP.

Implemented behavior:
- Manual SA20 host / IP field in plugin settings
- Volumio main volume slider controls SA20 volume
- On transition to `Play`, the plugin can:
  - power on the SA20 if needed
  - wait a configurable delay
  - switch to a configured input source
  - set a configured startup volume
- Manual test buttons remain available in the plugin settings page

Stability notes for v0.5.0:
- Removed recursive `volumioupdatevolume()` pushback loops
- Kept `volumeOverride` enabled so Volumio main volume remains the control path
- Balance command corrected to `0x3B`

Notes:
- Automatic discovery is not implemented in this build.
- Default Arcam TCP port is 50000.


- If the SA20 becomes unavailable or is no longer on while Volumio is still playing, the plugin stops Volumio playback after 5 minutes.
