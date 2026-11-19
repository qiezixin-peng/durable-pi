#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
service_script=$repo_root/unix/run-local-service.sh
[[ -f $HOME/.dpi/backend.env ]] || { echo 'Run bash ./unix/setup.sh first.' >&2; exit 1; }
chmod 700 "$service_script"

case $(uname -s) in
  Linux)
    command -v systemctl >/dev/null || { echo 'systemd user services are required.' >&2; exit 1; }
    unit_dir=$HOME/.config/systemd/user
    mkdir -p "$unit_dir"
    cat > "$unit_dir/durable-pi.service" <<EOF
[Unit]
Description=Durable Pi local runtime and task worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash $service_script
Restart=always
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable durable-pi.service >/dev/null
    systemctl --user restart durable-pi.service
    systemctl --user is-active --quiet durable-pi.service
    echo 'Durable Pi systemd user service installed and running.'
    ;;
  Darwin)
    plist_dir=$HOME/Library/LaunchAgents
    plist=$plist_dir/dev.durable-pi.runtime.plist
    mkdir -p "$plist_dir" "$HOME/.dpi/logs"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.durable-pi.runtime</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$service_script</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$HOME/.dpi/logs/service.log</string>
  <key>StandardErrorPath</key><string>$HOME/.dpi/logs/service-error.log</string>
</dict></plist>
EOF
    plutil -lint "$plist" >/dev/null
    launchctl bootout "gui/$(id -u)/dev.durable-pi.runtime" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    launchctl enable "gui/$(id -u)/dev.durable-pi.runtime"
    launchctl kickstart -k "gui/$(id -u)/dev.durable-pi.runtime"
    echo 'Durable Pi launchd service installed and running.'
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac
