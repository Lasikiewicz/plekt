#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER_NAME="${1:?Usage: restore-oracle-demo.sh CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
DATA_DIR="${2:?Usage: restore-oracle-demo.sh CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
HOST_PORT="${3:?Usage: restore-oracle-demo.sh CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
RUNTIME="${4:?Usage: restore-oracle-demo.sh CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
TRAKS_SCRIPT_URL="${5:-}"
TRAKS_SITE_KEY="${6:-}"
TRAKS_REQUIRE_CONSENT="${7:-true}"
TRAKS_COLLECTOR_ORIGIN="${8:-}"
IMAGE="localhost/plembfin-demo:latest"

if [[ "$RUNTIME" != "podman" ]]; then
  echo "The cached Oracle recovery image requires podman: $RUNTIME" >&2
  exit 1
fi
if [[ ! "$CONTAINER_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "Invalid container name: $CONTAINER_NAME" >&2
  exit 1
fi
if [[ ! "$DATA_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "Data directory must be an absolute, simple POSIX path: $DATA_DIR" >&2
  exit 1
fi
if [[ ! "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then
  echo "Invalid host port: $HOST_PORT" >&2
  exit 1
fi
if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "$RUNTIME is not installed on the OCI demo instance" >&2
  exit 1
fi

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "arm64" ]]; then
  echo "The cached recovery image is only approved for an ARM64 OCI host" >&2
  exit 1
fi

if (( EUID == 0 )); then
  SUDO=()
else
  SUDO=(sudo -n)
fi

run_runtime() {
  "${SUDO[@]}" "$RUNTIME" "$@"
}

image_arch="$(run_runtime image inspect --format '{{.Architecture}}' "$IMAGE")"
if [[ "$image_arch" != "arm64" && "$image_arch" != "aarch64" ]]; then
  echo "Cached recovery image is not ARM64: $image_arch" >&2
  exit 1
fi

existing_container=false
if run_runtime container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  existing_container=true
fi

if command -v ss >/dev/null 2>&1 \
  && [[ "$existing_container" != true ]] \
  && "${SUDO[@]}" ss -ltnH | awk -v port=":$HOST_PORT" '$4 ~ (port "$") { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "Port $HOST_PORT is already in use by an unrelated service" >&2
  exit 1
fi

if [[ "$existing_container" == true ]]; then
  run_runtime rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

"${SUDO[@]}" mkdir -p "$DATA_DIR"
echo "Restoring $CONTAINER_NAME from $IMAGE on port $HOST_PORT"
run_runtime run --detach \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --publish "$HOST_PORT:5055" \
  --volume "$DATA_DIR:/data:Z" \
  --env ADMIN_USERNAME=demo \
  --env ADMIN_PASSWORD=demo \
  --env BUILD_CHANNEL=main \
  --env COOKIE_SECURE=true \
  --env HOST=0.0.0.0 \
  --env PORT=5055 \
  --env PLEKT_DEMO_MODE=1 \
  --env PLEKT_DEMO_SEED=1 \
  --env PLEKT_TRAKS_SCRIPT_URL="$TRAKS_SCRIPT_URL" \
  --env PLEKT_TRAKS_COLLECTOR_ORIGIN="$TRAKS_COLLECTOR_ORIGIN" \
  --env PLEKT_TRAKS_SITE_KEY="$TRAKS_SITE_KEY" \
  --env PLEKT_TRAKS_REQUIRE_CONSENT="$TRAKS_REQUIRE_CONSENT" \
  --env TRUST_PROXY=1 \
  --security-opt no-new-privileges:true \
  --memory 512m \
  --cpus 1 \
  "$IMAGE"

if ! run_runtime ps --filter "name=^${CONTAINER_NAME}$" --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "The restored OCI demo container did not remain running" >&2
  run_runtime logs --tail 80 "$CONTAINER_NAME" >&2 || true
  exit 1
fi

echo "OCI demo recovery container is running $IMAGE"
