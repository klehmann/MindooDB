#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OVERRIDE_FILE="${MINDOODB_COMPOSE_OVERRIDE:-docker-compose.override.yml}"
SERVICE_NAME="${MINDOODB_DOCKER_SERVICE:-mindoodb}"

show_help() {
  cat <<'EOF'
MindooDB CLI (Docker)

Usage: ./mindoodb-cli.sh <command> [options]

Commands:
  identity:info              Show public info from an identity file
  identity:change-password   Change the password of an identity file
  identity:export-public     Export public keys from an identity file

Files in the data directory can be referenced by filename alone.
Example: ./mindoodb-cli.sh identity:info server.identity.json
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

detect_selinux_suffix() {
  if command -v sestatus >/dev/null 2>&1 && sestatus 2>/dev/null | grep -q "enabled"; then
    echo ":Z"
    return
  fi
  if command -v getenforce >/dev/null 2>&1; then
    local mode
    mode="$(getenforce 2>/dev/null || true)"
    if [[ "$mode" != "" && "$mode" != "Disabled" ]]; then
      echo ":Z"
      return
    fi
  fi
  echo ""
}

canonicalize_existing_path() {
  local input="$1"
  [[ -e "$input" ]] || return 1
  local dir
  dir="$(cd "$(dirname "$input")" && pwd)"
  printf '%s/%s\n' "$dir" "$(basename "$input")"
}

canonicalize_target_path() {
  local input="$1"
  local dir
  dir="$(cd "$(dirname "$input")" && pwd)"
  printf '%s/%s\n' "$dir" "$(basename "$input")"
}

extract_data_dir_host_path() {
  [[ -f "$OVERRIDE_FILE" ]] || fail "Missing $OVERRIDE_FILE. Run bash serversetup.sh first."

  local line value
  while IFS= read -r line; do
    value="${line#*- }"
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    if [[ "$value" == *:/data* ]]; then
      printf '%s\n' "${value%%:/data*}"
      return 0
    fi
  done < "$OVERRIDE_FILE"

  fail "Could not determine the /data bind mount from $OVERRIDE_FILE."
}

translate_input_path() {
  local input="$1"
  if [[ "$input" != */* ]]; then
    IDENTITY_HOST_PATH="${DATA_DIR_HOST}/${input}"
    IDENTITY_CONTAINER_PATH="/data/${input}"
    [[ -f "$IDENTITY_HOST_PATH" ]] || fail "Identity file not found: $IDENTITY_HOST_PATH"
    return 0
  fi

  local resolved
  resolved="$(canonicalize_existing_path "$input")" || fail "Identity file not found: $input"
  IDENTITY_HOST_PATH="$resolved"

  case "$resolved" in
    "$DATA_DIR_HOST")
      IDENTITY_CONTAINER_PATH="/data"
      ;;
    "$DATA_DIR_HOST"/*)
      IDENTITY_CONTAINER_PATH="/data/${resolved#"$DATA_DIR_HOST"/}"
      ;;
    *)
      EXTRA_VOLUMES+=("-v" "$(dirname "$resolved"):/tmp/cli-identity${SELINUX_SUFFIX}")
      IDENTITY_CONTAINER_PATH="/tmp/cli-identity/$(basename "$resolved")"
      ;;
  esac
}

translate_output_path() {
  local output="$1"
  local resolved

  if [[ "$output" != */* ]]; then
    resolved="$(canonicalize_target_path "./${output}")"
  else
    resolved="$(canonicalize_target_path "$output")"
  fi

  OUTPUT_HOST_PATH="$resolved"
  case "$resolved" in
    "$DATA_DIR_HOST")
      OUTPUT_CONTAINER_PATH="/data"
      ;;
    "$DATA_DIR_HOST"/*)
      OUTPUT_CONTAINER_PATH="/data/${resolved#"$DATA_DIR_HOST"/}"
      ;;
    *)
      EXTRA_VOLUMES+=("-v" "$(dirname "$resolved"):/tmp/cli-output${SELINUX_SUFFIX}")
      OUTPUT_CONTAINER_PATH="/tmp/cli-output/$(basename "$resolved")"
      ;;
  esac
}

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  show_help
  exit 1
fi
shift || true

CLI_SCRIPT=""
case "$COMMAND" in
  identity:info)
    CLI_SCRIPT="dist/node/cli/identity-info.js"
    ;;
  identity:change-password)
    CLI_SCRIPT="dist/node/cli/change-identity-password.js"
    ;;
  identity:export-public)
    CLI_SCRIPT="dist/node/cli/identity-export-public.js"
    ;;
  *)
    show_help
    fail "Unknown command: $COMMAND"
    ;;
esac

DATA_DIR_HOST="$(extract_data_dir_host_path)"
SELINUX_SUFFIX="$(detect_selinux_suffix)"
declare -a EXTRA_VOLUMES=()
declare -a PASSTHROUGH_ARGS=()
IDENTITY_INPUT=""
OUTPUT_INPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity)
      [[ $# -ge 2 ]] || fail "Missing value for --identity"
      IDENTITY_INPUT="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || fail "Missing value for --output"
      OUTPUT_INPUT="$2"
      shift 2
      ;;
    -h|--help)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
    *)
      if [[ -z "$IDENTITY_INPUT" && "$1" != -* ]]; then
        IDENTITY_INPUT="$1"
      else
        PASSTHROUGH_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

declare -a TRANSLATED_ARGS=()
if [[ ${#PASSTHROUGH_ARGS[@]} -gt 0 ]]; then
  TRANSLATED_ARGS+=("${PASSTHROUGH_ARGS[@]}")
fi
if [[ -n "$IDENTITY_INPUT" ]]; then
  translate_input_path "$IDENTITY_INPUT"
  TRANSLATED_ARGS+=("--identity" "$IDENTITY_CONTAINER_PATH")
fi

if [[ -n "$OUTPUT_INPUT" ]]; then
  translate_output_path "$OUTPUT_INPUT"
  TRANSLATED_ARGS+=("--output" "$OUTPUT_CONTAINER_PATH")
fi

declare -a TTY_ARGS=()
if [[ ! -t 0 ]]; then
  TTY_ARGS+=("-T")
fi

declare -a DOCKER_CMD=(docker compose run --rm --no-deps)
if [[ ${#TTY_ARGS[@]} -gt 0 ]]; then
  DOCKER_CMD+=("${TTY_ARGS[@]}")
fi
if [[ ${#EXTRA_VOLUMES[@]} -gt 0 ]]; then
  DOCKER_CMD+=("${EXTRA_VOLUMES[@]}")
fi
DOCKER_CMD+=(
  --entrypoint node
  "$SERVICE_NAME"
  "$CLI_SCRIPT"
)
if [[ ${#TRANSLATED_ARGS[@]} -gt 0 ]]; then
  DOCKER_CMD+=("${TRANSLATED_ARGS[@]}")
fi

"${DOCKER_CMD[@]}"
