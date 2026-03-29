#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# MindooDB Server — Interactive Setup
#
# Run from the repository root:
#   bash serversetup.sh
#
# The script builds the Docker image, creates the data directory and password
# file, initialises the server identity (with optional system admin creation),
# and writes a `docker-compose.override.yml` for docker compose.
# ---------------------------------------------------------------------------

DOCKER_IMAGE="mindoodb-server"
DOCKERFILE="src/node/server/Dockerfile"
DEFAULT_SERVER_NAME="server1"
DEFAULT_DATA_DIR="../mindoodb-data"
DEFAULT_BIND_ADDR="0.0.0.0"
DEFAULT_PORT="1661"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

# ── helpers ───────────────────────────────────────────────────────────────────

banner() {
  echo ""
  echo "============================================================"
  echo "  $1"
  echo "============================================================"
}

info()  { echo "  ▸ $*"; }
error() { echo "  ✗ $*" >&2; }

prompt_default() {
  local prompt="$1" default="$2" var_name="$3"
  printf "  %s [%s]: " "$prompt" "$default"
  read -r value
  eval "$var_name=\"\${value:-$default}\""
}

prompt_yes_no() {
  local prompt="$1" default="$2" var_name="$3" reply normalized
  local default_hint="y/N"
  if [[ "$default" == "y" ]]; then
    default_hint="Y/n"
  fi

  while true; do
    printf "  %s [%s]: " "$prompt" "$default_hint"
    read -r reply
    normalized="${reply:-$default}"
    normalized="${normalized,,}"
    case "$normalized" in
      y|yes)
        eval "$var_name=\"true\""
        return
        ;;
      n|no)
        eval "$var_name=\"false\""
        return
        ;;
      *)
        error "Please answer y or n."
        ;;
    esac
  done
}

prompt_password() {
  local prompt="$1" var_name="$2"
  while true; do
    printf "  %s: " "$prompt"
    read -rs password
    echo ""
    if [[ -z "$password" ]]; then
      error "Password cannot be empty."
      continue
    fi
    printf "  Confirm password: "
    read -rs password_confirm
    echo ""
    if [[ "$password" != "$password_confirm" ]]; then
      error "Passwords do not match. Try again."
      continue
    fi
    eval "$var_name=\"\$password\""
    return
  done
}

# ── preflight ─────────────────────────────────────────────────────────────────

banner "MindooDB Server — Interactive Setup"

if ! command -v docker &>/dev/null; then
  error "Docker is not installed or not in PATH."
  error "Install Docker first: https://docs.docker.com/get-docker/"
  exit 1
fi
info "Docker found: $(docker --version)"

if [[ ! -f "$DOCKERFILE" ]]; then
  error "Cannot find $DOCKERFILE — run this script from the MindooDB repository root."
  exit 1
fi

# ── prompts ───────────────────────────────────────────────────────────────────

banner "Configuration"

prompt_default "Server name" "$DEFAULT_SERVER_NAME" SERVER_NAME
prompt_password "Server unlock password" SERVER_PASSWORD
prompt_default "Data directory" "$DEFAULT_DATA_DIR" DATA_DIR
prompt_default "Bind address (0.0.0.0 = all interfaces)" "$DEFAULT_BIND_ADDR" BIND_ADDR
ALSO_BIND_LOCALHOST=false
if [[ "$BIND_ADDR" != "0.0.0.0" && "$BIND_ADDR" != "127.0.0.1" ]]; then
  prompt_yes_no "Also bind localhost (127.0.0.1) for local health checks?" "n" ALSO_BIND_LOCALHOST
fi
SERVER_DATA="$DATA_DIR/server"
PASSWORD_FILE="$DATA_DIR/.server_unlock"
IDENTITY_FILE="$SERVER_DATA/server-identity.json"

echo ""
info "Server name:    $SERVER_NAME"
info "Data directory: $DATA_DIR"
if $ALSO_BIND_LOCALHOST; then
  info "Bind addresses: 127.0.0.1:$DEFAULT_PORT, $BIND_ADDR:$DEFAULT_PORT"
else
  info "Bind address:   $BIND_ADDR:$DEFAULT_PORT"
fi
echo ""

# ── guard against re-init ─────────────────────────────────────────────────────

if [[ -f "$IDENTITY_FILE" ]]; then
  echo ""
  printf "  Server identity already exists at %s.\n" "$IDENTITY_FILE"
  printf "  Overwrite? (y/N): "
  read -r overwrite
  if [[ "${overwrite,,}" != "y" ]]; then
    info "Aborted. Existing identity kept."
    exit 0
  fi
  FORCE_FLAG="--force"
else
  FORCE_FLAG=""
fi

# ── create data directory and password file ───────────────────────────────────

banner "Creating data directory"

mkdir -p "$SERVER_DATA"
info "Created $SERVER_DATA"

printf '%s' "$SERVER_PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
info "Password written to $PASSWORD_FILE (mode 600)"

DATA_DIR_ABS="$(cd "$DATA_DIR" && pwd)"
SERVER_DATA_ABS="$DATA_DIR_ABS/server"
PASSWORD_FILE_ABS="$DATA_DIR_ABS/.server_unlock"

DATA_MOUNT="$SERVER_DATA_ABS:/data"
PASSWORD_MOUNT="$PASSWORD_FILE_ABS:/run/secrets/server_unlock:ro"
SELINUX_NOTES=""
if { command -v selinuxenabled &>/dev/null && selinuxenabled; } \
  || { command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" != "Disabled" ]]; }; then
  DATA_MOUNT="${DATA_MOUNT}:Z"
  PASSWORD_MOUNT="${PASSWORD_MOUNT},Z"
  SELINUX_NOTES=" (SELinux relabeling enabled)"
fi

info "Container runtime user will be ${HOST_UID}:${HOST_GID}${SELINUX_NOTES}"

# ── build docker image ────────────────────────────────────────────────────────

banner "Building Docker image"

docker build -f "$DOCKERFILE" -t "$DOCKER_IMAGE" .

info "Image $DOCKER_IMAGE built successfully."

# ── initialise server identity ────────────────────────────────────────────────

banner "Initialising server identity"

info "The server password is read from the mounted file."
info "You will be prompted to create a system admin interactively."
echo ""

docker run --rm -it \
  --user "${HOST_UID}:${HOST_GID}" \
  -v "$DATA_MOUNT" \
  -v "$PASSWORD_MOUNT" \
  -e MINDOODB_SERVER_PASSWORD_FILE=/run/secrets/server_unlock \
  -e MINDOODB_SKIP_NEXT_STEPS=1 \
  --entrypoint node \
  "$DOCKER_IMAGE" dist/node/server/serverinit.js --data-dir /data --name "$SERVER_NAME" $FORCE_FLAG

banner "Writing docker-compose.override.yml"

PORT_LINES=("      - \"${BIND_ADDR}:${DEFAULT_PORT}:${DEFAULT_PORT}\"")
HEALTHCHECK_URL="http://${BIND_ADDR}:${DEFAULT_PORT}/health"
if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
  HEALTHCHECK_URL="http://localhost:${DEFAULT_PORT}/health"
fi
if $ALSO_BIND_LOCALHOST; then
  PORT_LINES=("      - \"127.0.0.1:${DEFAULT_PORT}:${DEFAULT_PORT}\"" "${PORT_LINES[@]}")
  HEALTHCHECK_URL="http://localhost:${DEFAULT_PORT}/health"
fi

{
  echo "# Generated by serversetup.sh — customises uid/gid, bind mounts, and ports."
  echo "# docker compose merges this with docker-compose.yml automatically."
  echo "services:"
  echo "  mindoodb:"
  echo "    user: \"${HOST_UID}:${HOST_GID}\""
  echo "    volumes:"
  echo "      - \"${DATA_MOUNT}\""
  echo "      - \"${PASSWORD_MOUNT}\""
  echo "    ports:"
  printf '%s\n' "${PORT_LINES[@]}"
} > docker-compose.override.yml

if [[ -f .env ]]; then
  rm -f .env
  info "Removed stale .env from earlier setup runs"
fi

info "Override written to docker-compose.override.yml"

# ── summary ───────────────────────────────────────────────────────────────────

banner "Setup complete"

echo ""
info "Server name:       $SERVER_NAME"
info "Data directory:    $DATA_DIR/server"
info "Password file:     $PASSWORD_FILE"
if $ALSO_BIND_LOCALHOST; then
  info "Bind addresses:    127.0.0.1:$DEFAULT_PORT, $BIND_ADDR:$DEFAULT_PORT"
else
  info "Bind address:      $BIND_ADDR:$DEFAULT_PORT"
fi
info "Docker image:      $DOCKER_IMAGE"
info "Runtime user:      ${HOST_UID}:${HOST_GID}"
info "Override file:     docker-compose.override.yml"
echo ""
echo "  Next steps:"
echo ""
echo "    # Start the server"
echo "    docker compose up -d"
echo ""
echo "    # Check health"
echo "    curl ${HEALTHCHECK_URL}"
echo ""
echo "    # View logs"
echo "    docker compose logs -f"
echo ""
echo "    # Stop the server"
echo "    docker compose down"
echo ""
