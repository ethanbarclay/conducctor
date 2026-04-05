#!/bin/bash
# Pi HQ Camera (IMX477) → RTSP stream via mediamtx
# Run this on the Raspberry Pi
#
# Prerequisites (run once):
#   sudo apt install -y ffmpeg
#   wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_v1.9.1_linux_arm64v8.tar.gz
#   tar xzf mediamtx_*.tar.gz
#   ./mediamtx &   (or install as systemd service)
#
# Then run this script. Stream will be available at:
#   rtsp://PI_IP:8554/cam

# Resolution optimized for 50mm C-mount on IMX477
# Full sensor is 4056×3040 — we bin/crop to 1920×1080 for streaming speed
# The 50mm focal length at this crop factor ~= 10-11x zoom vs iPhone

WIDTH=1920
HEIGHT=1080
FPS=15           # 15fps is plenty for car detection, saves bandwidth
BITRATE=4000000  # 4 Mbps — crisp enough for plate-level detail at this focal length

libcamera-vid \
  --width $WIDTH \
  --height $HEIGHT \
  --framerate $FPS \
  --bitrate $BITRATE \
  --codec h264 \
  --inline \
  --timeout 0 \
  -o - \
| ffmpeg \
  -f h264 \
  -i pipe:0 \
  -c:v copy \
  -f rtsp \
  -rtsp_transport tcp \
  "rtsp://localhost:8554/cam"
