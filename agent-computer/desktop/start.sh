#!/bin/bash
# Bring up the desktop, the VNC bridge, and the agent server. The agent server launches the HEADED
# Chromium itself (headless:false + DISPLAY), so the browser the agent drives is the one on screen.
export DISPLAY=":${DISPLAY_NUM:-1}"
RES="${WIDTH:-1280}x${HEIGHT:-800}x24"

# Virtual display.
Xvfb "$DISPLAY" -screen 0 "$RES" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 40); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.25; done

# Session bus, window manager, dock.
eval "$(dbus-launch --sh-syntax 2>/dev/null)" || true
openbox >/tmp/openbox.log 2>&1 &
tint2 >/tmp/tint2.log 2>&1 &

# VNC over the display, then noVNC (websockify) serving it on 6080 for the iframe.
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -xkb -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# The governed agent-computer server. In desktop mode it launches Chromium headed on $DISPLAY.
cd /opt/agent-computer
exec /root/.bun/bin/bun run src/index.ts
