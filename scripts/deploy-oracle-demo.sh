#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy one exact, already-published Plekt release to the dedicated OCI
# demo instance. The script is intentionally self-contained so the GitHub
# main-release job can copy it over SSH without copying the repository or any
# credentials to the instance.

IMAGE="${1:?Usage: deploy-oracle-demo.sh IMAGE CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
CONTAINER_NAME="${2:?Usage: deploy-oracle-demo.sh IMAGE CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
DATA_DIR="${3:?Usage: deploy-oracle-demo.sh IMAGE CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
HOST_PORT="${4:?Usage: deploy-oracle-demo.sh IMAGE CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
RUNTIME="${5:?Usage: deploy-oracle-demo.sh IMAGE CONTAINER_NAME DATA_DIR HOST_PORT RUNTIME [TRAKS_SCRIPT_URL] [TRAKS_SITE_KEY] [TRAKS_REQUIRE_CONSENT] [TRAKS_COLLECTOR_ORIGIN]}"
TRAKS_SCRIPT_URL="${6:-}"
TRAKS_SITE_KEY="${7:-}"
TRAKS_REQUIRE_CONSENT="${8:-true}"
TRAKS_COLLECTOR_ORIGIN="${9:-}"

if [[ ! "$IMAGE" =~ ^ghcr\.io/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$ ]]; then
  echo "Refusing an image outside the expected GHCR repository: $IMAGE" >&2
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
if [[ "$RUNTIME" != "podman" && "$RUNTIME" != "docker" ]]; then
  echo "Runtime must be podman or docker: $RUNTIME" >&2
  exit 1
fi

if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "$RUNTIME is not installed on the OCI demo instance" >&2
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

echo "Freeing disk space and clearing temporary storage before pulling $IMAGE"
"${SUDO[@]}" rm -rf /var/tmp/container_images_storage* 2>/dev/null || true
run_runtime image prune --all --force >/dev/null 2>&1 || true

echo "Pulling $IMAGE with $RUNTIME"
runtime_arch_args=()
if ! run_runtime pull "$IMAGE"; then
  host_arch="$(uname -m)"
  if [[ "$host_arch" != "aarch64" && "$host_arch" != "arm64" ]]; then
    exit 1
  fi

  echo "No native image is available for ARM64; retrying the existing release image as amd64"
  if [[ "$RUNTIME" == "podman" ]]; then
    runtime_arch_args=(--arch amd64)
  else
    runtime_arch_args=(--platform linux/amd64)
  fi
  run_runtime pull "${runtime_arch_args[@]}" "$IMAGE"
fi

# An ARM host can pull an amd64 image when the architecture is forced, but it
# still needs binfmt/QEMU support to execute it. Probe the image before touching
# the currently running demo container so an incompatible release cannot cause
# avoidable downtime.
if (( ${#runtime_arch_args[@]} > 0 )); then
  echo "Checking amd64 execution support before replacing the running demo"
  run_runtime run --rm "${runtime_arch_args[@]}" --entrypoint /bin/true "$IMAGE"
fi

# Reuse the existing /data mount when replacing an older demo container. This
# keeps the fixture and generated config intact across releases. A new data
# directory is only used on the first installation.
existing_data=""
existing_container=false
existing_container_owns_port=false
if run_runtime container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  existing_container=true
  existing_data="$(run_runtime container inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER_NAME" | tr -d '\r\n')"
  if [[ -n "$existing_data" ]]; then
    DATA_DIR="$existing_data"
    echo "Reusing the existing /data mount: $DATA_DIR"
  fi
  if run_runtime port "$CONTAINER_NAME" 2>/dev/null \
    | awk -v host_port=":$HOST_PORT" '$0 ~ host_port "$" { found = 1 } END { exit found ? 0 : 1 }'; then
    existing_container_owns_port=true
  fi
  if [[ -z "$existing_data" && -e "$DATA_DIR" ]] \
    && [[ -n "$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Configured data directory is non-empty but the existing container has no /data mount: $DATA_DIR" >&2
    echo "Refusing to merge unknown data during the first OCI deployment" >&2
    exit 1
  fi
fi

# Do not stop an unrelated service that happens to own the public port. A
# dedicated OCI demo host should have no such listener; failing here preserves
# that safety invariant and makes the misconfiguration visible in CI.
if command -v ss >/dev/null 2>&1 \
  && [[ "$existing_container_owns_port" != true ]] \
  && "${SUDO[@]}" ss -ltnH | awk -v port=":$HOST_PORT" '$4 ~ (port "$") { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "Port $HOST_PORT is already in use by a service other than $CONTAINER_NAME" >&2
  echo "Listeners on port $HOST_PORT:" >&2
  "${SUDO[@]}" ss -ltnp 2>/dev/null | awk -v port=":$HOST_PORT" '$4 ~ (port "$")' >&2 || true
  echo "Containers on the OCI host:" >&2
  run_runtime ps --all --format '{{.Names}}\t{{.Ports}}' >&2 || true
  exit 1
fi

if [[ "$existing_container" == true ]]; then
  run_runtime stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ -z "$existing_data" ]]; then
    # The current OCI container was created without a host mount. Copy its
    # demo state into the configured persistent directory while the stopped
    # container is still available, then remove only that container.
    "${SUDO[@]}" mkdir -p "$DATA_DIR"
    echo "Migrating the existing container /data into $DATA_DIR"
    run_runtime cp "$CONTAINER_NAME:/data/." "$DATA_DIR/"
  fi
  run_runtime rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  run_runtime image prune --all --force >/dev/null 2>&1 || true
fi

"${SUDO[@]}" mkdir -p "$DATA_DIR"

echo "Starting $CONTAINER_NAME on port $HOST_PORT"
run_runtime run "${runtime_arch_args[@]}" --detach \
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
  echo "The OCI demo container did not remain running" >&2
  run_runtime logs --tail 80 "$CONTAINER_NAME" >&2 || true
  exit 1
fi

echo "OCI demo is running $IMAGE"
