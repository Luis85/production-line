#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == system ]]; then shift; exec bash "$release_dir/scripts/docker/system.sh" "$@"; fi
command_name="${1:-help}"
if (($#)); then shift; fi
state_dir="$release_dir/.werk"
no_open=false
json=false
forward=()
while (($#)); do
  case "$1" in
    --state-dir) [[ $# -ge 2 && -n "$2" ]] || { echo '--state-dir requires a path' >&2; exit 2; }; state_dir="$2"; shift 2 ;;
    --no-open) no_open=true; shift ;;
    --json) json=true; shift ;;
    *) forward+=("$1"); shift ;;
  esac
done
case "$command_name" in
  help|--help) printf '%s\n' 'Werk Docker release (mock): setup | start [--no-open] | status | logs | stop | cli <orchestrator arguments>' 'Options: --state-dir PATH, --json. Setup accepts --project ID --port N --worker-port N --workers 1.'; exit 0 ;;
  setup|start|status|logs|stop|cli) ;;
  *) echo 'Unknown command; use help' >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo 'Docker with Compose is required; host Node.js is not required.' >&2; exit 1; }
docker compose version >/dev/null
if [[ "$command_name" == setup ]]; then mkdir -p -- "$state_dir"; fi
[[ -d "$state_dir" && ! -L "$state_dir" ]] || { echo 'State directory is missing or a symlink. Run setup with a private directory.' >&2; exit 1; }
state_dir="$(cd -- "$state_dir" && pwd -P)"
[[ "$state_dir" != *','* && "$state_dir" != *$'\n'* && "$state_dir" != *$'\r'* ]] || { echo 'State directory must not contain commas or line breaks.' >&2; exit 2; }
export WERK_DOCKER_STATE_DIR="$state_dir"
export WERK_DOCKER_UID="$(id -u)" WERK_DOCKER_GID="$(id -g)"
export WERK_DOCKER_IMAGE="${WERK_DOCKER_IMAGE:-werk-release:local}"
if [[ "$command_name" == setup || "$command_name" == start ]]; then
  docker build --file "$release_dir/Dockerfile.release" --tag "$WERK_DOCKER_IMAGE" "$release_dir" >&2
fi
operator=(docker run --rm --user "$WERK_DOCKER_UID:$WERK_DOCKER_GID" --mount "type=bind,source=$state_dir,target=/state" "$WERK_DOCKER_IMAGE")
if [[ "$command_name" == setup ]]; then
  "${operator[@]}" setup --host-state "$state_dir" "${forward[@]}"
  exit 0
fi
[[ -f "$state_dir/docker.env" && ! -L "$state_dir/docker.env" ]] || { echo 'Docker setup metadata is missing; run setup first.' >&2; exit 1; }
compose=(docker compose --project-directory "$release_dir" --env-file "$state_dir/docker.env" --file "$release_dir/compose.release.yaml")
# Compose substitutes COMPOSE_PROJECT_NAME from this explicit nonsecret CLI option.
project_name="$(docker run --rm --user "$WERK_DOCKER_UID:$WERK_DOCKER_GID" --mount "type=bind,source=$state_dir,target=/state,readonly" --entrypoint node "$WERK_DOCKER_IMAGE" -e 'const fs=require("node:fs");const s=fs.readFileSync("/state/docker.env","utf8");const m=/^WERK_DOCKER_PROJECT=(werk-[a-f0-9]{12})$/m.exec(s);if(!m)process.exit(2);process.stdout.write(m[1]);')"
compose+=(--project-name "$project_name")
if [[ "$command_name" != cli && ${#forward[@]} -ne 0 ]]; then echo 'Unknown options for Docker command' >&2; exit 2; fi
case "$command_name" in
  start)
    "${compose[@]}" up --detach --wait --wait-timeout 90 orchestrator worker >&2
    "${compose[@]}" exec -T orchestrator node /app/scripts/docker/operator.mjs status
    if [[ "$no_open" == false && "$json" == false ]]; then
      url="$("${operator[@]}" url)"
      if command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then xdg-open "$url" >/dev/null 2>&1 || printf 'Open %s\n' "$url" >&2
      elif command -v open >/dev/null; then open "$url" >/dev/null 2>&1 || printf 'Open %s\n' "$url" >&2
      else printf 'Open %s\n' "$url" >&2; fi
    fi ;;
  status) "${compose[@]}" exec -T orchestrator node /app/scripts/docker/operator.mjs status ;;
  stop) "${compose[@]}" stop --timeout 20 orchestrator worker >&2; printf '%s\n' '{"stopped":true,"statePreserved":true}' ;;
  logs)
    if [[ "$json" == true ]]; then "${compose[@]}" logs --no-color --tail 100 orchestrator worker | docker run --rm -i "$WERK_DOCKER_IMAGE" logs-json
    else "${compose[@]}" logs --no-color --tail 100 orchestrator worker; fi ;;
  cli) "${compose[@]}" exec -T orchestrator node /app/scripts/docker/operator.mjs cli "${forward[@]}" ;;
esac
