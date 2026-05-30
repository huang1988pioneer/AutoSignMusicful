#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.codex.musicful-auto-sign.plist"
NODE_BIN="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT_DIR/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.musicful-auto-sign</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/scripts/musicful-signin.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>13</integer>
    <key>Minute</key>
    <integer>10</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$ROOT_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT_DIR/logs/launchd.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"

echo "Installed: $PLIST"
echo "Musicful auto sign-in will run every day at 13:10 Asia/Taipei."
