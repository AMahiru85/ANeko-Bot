#!/usr/bin/env bash
set -Eeuo pipefail

# Remote bootstrapper. The full installer is pulled from the repository and
# then clones the application into INSTALL_DIR.
REPO_URL="${REPO_URL:-https://github.com/AMahiru85/ANeko-Bot.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aneko-bot}"
INSTALLER_URL="${INSTALLER_URL:-https://raw.githubusercontent.com/AMahiru85/ANeko-Bot/main/deploy/install.sh}"

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to download the remote installer." >&2
  exit 1
}

echo "Downloading ANeko-Bot installer from ${INSTALLER_URL}"
curl --fail --silent --show-error --location "${INSTALLER_URL}" \
  | REPO_URL="${REPO_URL}" INSTALL_DIR="${INSTALL_DIR}" bash -s -- --install
