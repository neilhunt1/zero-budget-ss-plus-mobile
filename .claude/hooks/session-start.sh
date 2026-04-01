#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote (cloud) sessions.
# When running locally, dependencies are already installed.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] Installing npm dependencies..."
npm install
echo "[session-start] Done."

# Note: GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_SHEET_ID are injected directly
# into process.env by the Claude Code cloud environment variable settings.
# The setup script (scripts/setup-sheet.ts) reads them from process.env automatically.
# No extra env-file writing needed here.
