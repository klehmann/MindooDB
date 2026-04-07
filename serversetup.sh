#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# MindooDB Server — Interactive Setup
#
# Run from the repository root:
#   bash serversetup.sh
#   bash serversetup.sh --update
#
# The script builds the Docker image, creates the data directory and password
# file, initialises the server identity (with optional system admin creation),
# and writes a `docker-compose.override.yml` for docker compose. Update mode
# rebuilds and refreshes docker-compose.override.yml without touching identity
# files, config, keybag, tenant data, or the password file.
# ---------------------------------------------------------------------------

DOCKER_IMAGE="mindoodb-server"
DOCKERFILE="src/node/server/Dockerfile"
DEFAULT_SERVER_NAME="server1"
DEFAULT_DATA_DIR="../mindoodb-data"
DEFAULT_BIND_ADDR="0.0.0.0"
DEFAULT_PORT="1661"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
MODE="setup"
MODE_SOURCE="default"
SERVER_PASSWORD=""
SERVER_DATA=""
PASSWORD_FILE=""
IDENTITY_FILE=""
DATA_DIR_ABS=""
SERVER_DATA_ABS=""
PASSWORD_FILE_ABS=""
DATA_MOUNT=""
PASSWORD_MOUNT=""
SELINUX_NOTES=""
HEALTHCHECK_URL=""
FORCE_FLAG=""
ALSO_BIND_LOCALHOST=false

show_help() {
  cat <<'EOF'
MindooDB Server — Interactive Setup

Usage:
  bash serversetup.sh
  bash serversetup.sh --update
  bash serversetup.sh --help

Modes:
  default     Interactive setup. If an existing server identity is detected,
              the script offers a safe update flow, full overwrite, or abort.
  --update    Safe update flow for an existing deployment. Rebuilds the Docker
              image and rewrites docker-compose.override.yml without touching
              server.identity.json, server.keybag, config.json, tenant data,
              or .server_unlock.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --update)
        MODE="update"
        MODE_SOURCE="flag"
        shift
        ;;
      -h|--help)
        show_help
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        echo ""
        show_help
        exit 1
        ;;
    esac
  done
}

# ── helpers ───────────────────────────────────────────────────────────────────

banner() {
  echo ""
  echo "============================================================"
  echo "  $1"
  echo "============================================================"
}

info()  { echo "  ▸ $*"; }
error() { echo "  ✗ $*" >&2; }

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

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
    normalized="$(to_lower "$normalized")"
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

prompt_choice() {
  local prompt="$1" var_name="$2"
  shift 2
  local choices=("$@")
  local reply normalized
  while true; do
    printf "  %s " "$prompt"
    read -r reply
    normalized="$(to_lower "$reply")"
    for choice in "${choices[@]}"; do
      if [[ "$normalized" == "$choice" ]]; then
        eval "$var_name=\"\$normalized\""
        return
      fi
    done
    error "Please answer one of: ${choices[*]}"
  done
}

set_data_paths() {
  SERVER_DATA="$DATA_DIR/server"
  PASSWORD_FILE="$DATA_DIR/.server_unlock"
  IDENTITY_FILE="$SERVER_DATA/server.identity.json"
}

prepare_mounts() {
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
}

prepare_ports() {
  PORT_LINES=("      - \"${BIND_ADDR}:${DEFAULT_PORT}:${DEFAULT_PORT}\"")
  HEALTHCHECK_URL="http://${BIND_ADDR}:${DEFAULT_PORT}/health"
  if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
    HEALTHCHECK_URL="http://localhost:${DEFAULT_PORT}/health"
  fi
  if $ALSO_BIND_LOCALHOST; then
    PORT_LINES=("      - \"127.0.0.1:${DEFAULT_PORT}:${DEFAULT_PORT}\"" "${PORT_LINES[@]}")
    HEALTHCHECK_URL="http://localhost:${DEFAULT_PORT}/health"
  fi
}

write_override_file() {
  banner "Writing docker-compose.override.yml"
  prepare_ports
  {
    echo "# Generated by serversetup.sh — customises uid/gid, bind mounts, and ports."
    echo "# docker compose merges this with docker-compose.yml automatically."
    echo "version: \"3.8\""
    echo "services:"
    echo "  mindoodb:"
    echo "    user: \"${HOST_UID}:${HOST_GID}\""
    echo "    volumes:"
    echo "      - \"${DATA_MOUNT}\""
    echo "      - \"${PASSWORD_MOUNT}\""
    echo "    ports:"
    printf '%s\n' "${PORT_LINES[@]}"
  } > docker-compose.override.yml

  info "Override written to docker-compose.override.yml"
}

write_password_file() {
  banner "Creating data directory"

  mkdir -p "$SERVER_DATA"
  info "Created $SERVER_DATA"

  printf '%s' "$SERVER_PASSWORD" > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
  info "Password written to $PASSWORD_FILE (mode 600)"
}

build_docker_image() {
  banner "Building Docker image"
  docker build -f "$DOCKERFILE" -t "$DOCKER_IMAGE" .
  info "Image $DOCKER_IMAGE built successfully."
}

run_server_init() {
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
}

print_summary() {
  local heading="$1"
  local start_command="$2"
  banner "$heading"

  echo ""
  info "Server name:       ${SERVER_NAME:-unchanged}"
  info "Data directory:    $DATA_DIR/server"
  if [[ -n "${SERVER_PASSWORD:-}" ]]; then
    info "Password file:     $PASSWORD_FILE"
  else
    info "Password file:     $PASSWORD_FILE (preserved)"
  fi
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
  echo "    # Start or restart the server"
  echo "    ${start_command}"
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
}

run_setup_mode() {
  FORCE_FLAG=""
  if [[ -f "$IDENTITY_FILE" ]]; then
    if [[ "$MODE_SOURCE" == "flag" ]]; then
      error "Update mode was requested, but $IDENTITY_FILE already exists. Use the default interactive mode if you want to overwrite it."
      exit 1
    fi
    echo ""
    printf "  Server identity already exists at %s.\n" "$IDENTITY_FILE"
    printf "  Choose action: [u]pdate safely / [o]verwrite identity / [a]bort: "
    local action
    read -r action
    case "$(to_lower "$action")" in
      u)
        MODE="update"
        SERVER_NAME="unchanged"
        ;;
      o)
        FORCE_FLAG="--force"
        ;;
      ""|a)
        info "Aborted. Existing identity kept."
        exit 0
        ;;
      *)
        error "Please answer u, o, or a."
        exit 1
        ;;
    esac
    if [[ "$MODE" == "update" ]]; then
      run_update_mode
      return
    fi
  fi

  prompt_password "Server unlock password" SERVER_PASSWORD

  echo ""
  info "Server name:    $SERVER_NAME"
  info "Data directory: $DATA_DIR"
  if $ALSO_BIND_LOCALHOST; then
    info "Bind addresses: 127.0.0.1:$DEFAULT_PORT, $BIND_ADDR:$DEFAULT_PORT"
  else
    info "Bind address:   $BIND_ADDR:$DEFAULT_PORT"
  fi
  echo ""

  write_password_file
  prepare_mounts
  info "Container runtime user will be ${HOST_UID}:${HOST_GID}${SELINUX_NOTES}"
  build_docker_image
  run_server_init
  write_override_file

  if [[ -f .env ]]; then
    rm -f .env
    info "Removed stale .env from earlier setup runs"
  fi

  print_summary "Setup complete" "docker compose up -d"
}

run_update_mode() {
  if [[ ! -f "$IDENTITY_FILE" ]]; then
    error "No existing server identity found at $IDENTITY_FILE."
    error "Run bash serversetup.sh first, or choose a data directory that already contains a server."
    exit 1
  fi
  if [[ ! -f "$PASSWORD_FILE" ]]; then
    error "Missing existing password file at $PASSWORD_FILE."
    error "Safe update mode preserves the existing password file and requires it to already be present."
    exit 1
  fi

  echo ""
  info "Safe update mode selected."
  info "Existing identity, keybag, config, tenant data, and password file will be preserved."
  info "Data directory: $DATA_DIR"
  if $ALSO_BIND_LOCALHOST; then
    info "Bind addresses: 127.0.0.1:$DEFAULT_PORT, $BIND_ADDR:$DEFAULT_PORT"
  else
    info "Bind address:   $BIND_ADDR:$DEFAULT_PORT"
  fi
  echo ""

  mkdir -p "$SERVER_DATA"
  prepare_mounts
  info "Container runtime user will be ${HOST_UID}:${HOST_GID}${SELINUX_NOTES}"
  build_docker_image
  write_override_file
  print_summary "Update ready" "docker compose up -d --build"
}

# ── preflight ─────────────────────────────────────────────────────────────────

parse_args "$@"
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

if [[ "$MODE" == "update" ]]; then
  SERVER_NAME="unchanged"
else
  prompt_default "Server name" "$DEFAULT_SERVER_NAME" SERVER_NAME
fi
prompt_default "Data directory" "$DEFAULT_DATA_DIR" DATA_DIR
set_data_paths
prompt_default "Bind address (0.0.0.0 = all interfaces)" "$DEFAULT_BIND_ADDR" BIND_ADDR
if [[ "$BIND_ADDR" != "0.0.0.0" && "$BIND_ADDR" != "127.0.0.1" ]]; then
  prompt_yes_no "Also bind localhost (127.0.0.1) for local health checks?" "n" ALSO_BIND_LOCALHOST
fi

if [[ "$MODE" == "update" ]]; then
  run_update_mode
else
  run_setup_mode
fi
