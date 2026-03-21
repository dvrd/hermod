#!/usr/bin/env bash
set -euo pipefail

# Hermod Poller — service installer
# Supports macOS (launchd) and Linux (systemd)

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="ai.donostia.hermod-poller"
ENV_FILE="$REPO_DIR/.env"

# ── Checks ────────────────────────────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found"
  echo "Copy .env.example to .env and fill in your values first."
  exit 1
fi

BUN_BIN="$(which bun 2>/dev/null || true)"
if [ -z "$BUN_BIN" ]; then
  echo "error: bun not found in PATH"
  echo "Install bun: https://bun.sh"
  exit 1
fi

# ── macOS ─────────────────────────────────────────────────────────────────────

install_macos() {
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/$SERVICE_NAME.plist"
  LOG_DIR="$HOME/.logs"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  # Build EnvironmentVariables block from .env
  ENV_BLOCK=""
  while IFS='=' read -r key value || [ -n "$key" ]; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    # Strip leading/trailing whitespace and quotes
    key="${key// /}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    ENV_BLOCK+="        <key>$key</key>
        <string>$value</string>
"
  done < "$ENV_FILE"

  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>run</string>
        <string>$REPO_DIR/poller.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
$ENV_BLOCK    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/hermod-poller.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/hermod-poller.err</string>
</dict>
</plist>
EOF

  # Unload if already running
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load "$PLIST_FILE"

  echo "✓ hermod poller installed and started (macOS launchd)"
  echo "  logs:    tail -f $LOG_DIR/hermod-poller.log"
  echo "  stop:    launchctl unload $PLIST_FILE"
  echo "  restart: launchctl kickstart -k gui/$(id -u)/$SERVICE_NAME"
}

# ── Linux ─────────────────────────────────────────────────────────────────────

install_linux() {
  UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
  mkdir -p "$(dirname "$UNIT_FILE")"

  # Build Environment= lines from .env
  ENV_LINES=""
  while IFS='=' read -r key value || [ -n "$key" ]; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    key="${key// /}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    ENV_LINES+="Environment=\"$key=$value\"
"
  done < "$ENV_FILE"

  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Hermod Poller — GitHub PR comment relay to Paperclip
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$BUN_BIN run $REPO_DIR/poller.ts
$ENV_LINES
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME"

  echo "✓ hermod poller installed and started (systemd user service)"
  echo "  logs:    journalctl --user -u $SERVICE_NAME -f"
  echo "  stop:    systemctl --user stop $SERVICE_NAME"
  echo "  restart: systemctl --user restart $SERVICE_NAME"
}

# ── Uninstall ─────────────────────────────────────────────────────────────────

uninstall_macos() {
  PLIST_FILE="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  rm -f "$PLIST_FILE"
  echo "✓ hermod poller uninstalled"
}

uninstall_linux() {
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
  systemctl --user daemon-reload
  echo "✓ hermod poller uninstalled"
}

# ── Main ──────────────────────────────────────────────────────────────────────

ACTION="${1:-install}"
OS="$(uname -s)"

case "$ACTION" in
  install)
    case "$OS" in
      Darwin) install_macos ;;
      Linux)  install_linux ;;
      *) echo "error: unsupported OS: $OS"; exit 1 ;;
    esac
    ;;
  uninstall)
    case "$OS" in
      Darwin) uninstall_macos ;;
      Linux)  uninstall_linux ;;
      *) echo "error: unsupported OS: $OS"; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: $0 [install|uninstall]"
    exit 1
    ;;
esac
