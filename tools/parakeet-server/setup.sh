#!/bin/bash
# Setup Parakeet MLX server on Mac mini
# Run this ON the Mac mini (not on the Linux box)
#
# Usage: bash setup.sh
#
set -e

INSTALL_DIR="$HOME/parakeet-server"
PORT="${PARAKEET_PORT:-9003}"
LABEL="com.pdfzipper.parakeet-server"

echo "=== Parakeet MLX Server Setup ==="
echo "Install dir: $INSTALL_DIR"
echo "Port: $PORT"
echo ""

# 1. Check prerequisites
command -v python3 >/dev/null || { echo "ERROR: python3 not found"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not found. Install: brew install ffmpeg"; exit 1; }
python3 -c "import platform; assert platform.machine() == 'arm64'" 2>/dev/null || {
    echo "ERROR: Apple Silicon required (got $(python3 -c 'import platform; print(platform.machine())'))"
    exit 1
}

# 2. Create venv
echo "[1/4] Creating Python environment..."
mkdir -p "$INSTALL_DIR"
cp server.py "$INSTALL_DIR/"
cp requirements.txt "$INSTALL_DIR/"
cd "$INSTALL_DIR"

if [ ! -d venv ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt

# 3. Test model download (will cache in ~/.cache/huggingface/)
echo "[2/4] Downloading model (first time only, ~1.2GB)..."
python3 -c "from parakeet_mlx import from_pretrained; m = from_pretrained('mlx-community/parakeet-tdt-0.6b-v3'); print('Model loaded OK')"

# 4. Create launchd plist for auto-start
echo "[3/4] Installing launchd service..."
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/venv/bin/uvicorn</string>
        <string>server:app</string>
        <string>--host</string>
        <string>0.0.0.0</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/parakeet.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/parakeet.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${INSTALL_DIR}/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>PARAKEET_MODEL</key>
        <string>mlx-community/parakeet-tdt-0.6b-v3</string>
    </dict>
</dict>
</plist>
PLISTEOF

# Stop old instance if running
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"

echo "[4/4] Waiting for server to start..."
sleep 3

# 5. Verify
if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo ""
    echo "=== SUCCESS ==="
    echo "Parakeet server running at http://$(hostname):${PORT}"
    echo "Health: $(curl -s http://localhost:${PORT}/health)"
    echo ""
    echo "Test: curl -X POST http://$(hostname):${PORT}/asr?output=txt -F 'audio_file=@test.mp3'"
    echo "Logs: tail -f ${INSTALL_DIR}/parakeet.log"
    echo ""
    echo "To update pdf-zipper-v2, set WHISPER_HOST=http://$(hostname):${PORT} in docker-compose.yml"
else
    echo ""
    echo "Server may still be loading the model (first request triggers download)."
    echo "Check: tail -f ${INSTALL_DIR}/parakeet.log"
    echo "Then:  curl http://localhost:${PORT}/health"
fi
