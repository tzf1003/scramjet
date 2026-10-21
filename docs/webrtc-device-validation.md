# WebRTC real-device validation

The automated suite uses real browser networking and controlled virtual media.
Physical cameras, OS permission dialogs, Windows, Android Chrome and iOS Safari
require their own results. Playwright WebKit is recorded separately.

Use `tests/webrtc/device-probe.html` for the following acceptance procedure. It
uses native RTCPeerConnection, RTP and DataChannel, hashes a 128 KiB exchange and
exports native stats. Serve it from a separate HTTPS target origin and navigate
to that URL through the configured Scramjet deployment. Do not inject the probe
straight into the Controller's own origin.

1. Deploy Coturn with trusted TLS, short-lived authenticated credentials and the
   desired public IPv4/IPv6 addresses using `webrtc-deployment.md`. Start a client
   capture outside the browser. Record the software revision, device OS/browser,
   network interfaces, TURN URLs/ports, certificate chain and capture start time.
2. On device A open the probe through Scramjet with `relay` enabled. On independent
   device B open the target probe directly. The proxied A must report `relay` and
   only configured TURN URLs. B may use native host candidates; this provides an
   independent observation of A's TURN exit.
3. Grant camera/microphone on A. Press **Create offer**, copy the gathered local
   JSON to B's remote field and apply it. Copy B's answer to A and apply it. Both
   the 128 KiB hash check and remote media playback must succeed. Enable capture
   on B and renegotiate in the opposite direction for bidirectional media.
4. On supported desktop browsers press **Capture screen**, renegotiate, and
   change the displayed window. B must receive the changing screen track. Record
   permission grants and denials. A browser lacking `getDisplayMedia` reports
   that API error; it does not simulate screen sharing.
5. Repeat **Restart ICE and create offer** and exchange the new descriptions.
   Check changing counters, selected pairs, remote observations and another hash
   exchange. Open a second proxied top-level tab and repeat concurrently.
6. In an owned environment stop TURN, use wrong credentials, switch network,
   enable/disable the owned VPN, and repeat ICE restart. A must not reach an
   unauthorized STUN or peer address. Restore the services, rebuild the failed
   peer/channel and exchange fresh descriptions; never label a queued message
   or a connection state alone as successful delivery.
7. Export JSON on both endpoints and stop the capture. Run the packet analyzer
   against the exact installed policy/receipt. Correlate B's observed source
   address/port with A's allocation and the TURN-side capture. Record all failure
   conditions and attach the files to that device's acceptance record.

For **Enforced** acceptance, the device's browser must actually sit behind the
verified OS/network boundary. A JavaScript flag and mobile browser emulation do
not establish it. The repository provides the Linux namespace implementation;
Windows/mobile operating-system deployment needs its own equivalent routing and
firewall evidence. Device JSON and PCAP can contain addresses and media metadata;
keep captured runs in the authorized evidence storage.

To repeat automated media and stability runs:

```sh
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers TURN_TTL=3600 WEBRTC_SOAK_SECONDS=3600 WEBRTC_MEDIA_SOAK_SECONDS=60 python3 tests/webrtc/run-browser-suite.py --browser chromium --output /Volumes/1T/scramjet/verification/hour-soak
rtk python3 tests/webrtc/isolation/run-linux-suite.py --output /Volumes/1T/scramjet/verification/linux-ipv4
rtk python3 tests/webrtc/isolation/run-linux-suite.py --ipv6 --output /Volumes/1T/scramjet/verification/linux-ipv6
```

The Linux runner reuses an existing Playwright/Node image. Its Dockerfile is
`tests/webrtc/isolation/Dockerfile`; build it once into the shared Docker cache.
The source and existing dependencies are mounted, and each run removes only its
own containers and network. See the test report for durations actually executed.
