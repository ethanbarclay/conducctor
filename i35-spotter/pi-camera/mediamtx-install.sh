#!/bin/bash
# Install mediamtx as a systemd service on the Pi
# Run once as root/sudo

set -e

ARCH=$(uname -m)
VERSION="v1.9.1"

if [ "$ARCH" = "aarch64" ]; then
  TARBALL="mediamtx_${VERSION}_linux_arm64v8.tar.gz"
else
  TARBALL="mediamtx_${VERSION}_linux_armv7.tar.gz"
fi

echo "Downloading mediamtx $VERSION for $ARCH..."
wget -q "https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/${TARBALL}"
tar xzf "$TARBALL" mediamtx mediamtx.yml
rm "$TARBALL"

# Install binary
sudo mv mediamtx /usr/local/bin/mediamtx
sudo chmod +x /usr/local/bin/mediamtx
sudo mv mediamtx.yml /etc/mediamtx.yml

# Create systemd service
sudo tee /etc/systemd/system/mediamtx.service > /dev/null <<EOF
[Unit]
Description=mediamtx RTSP server
After=network.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx.yml
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mediamtx
sudo systemctl start mediamtx

echo "mediamtx running. Stream will be at rtsp://$(hostname -I | awk '{print $1}'):8554/cam"
echo "Now run: ./stream.sh"
