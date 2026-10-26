#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
action="${1:-help}"; if (($#)); then shift; fi
state_dir=''; definition_file=''; environment=''; no_open=false; json=false
while (($#)); do
  case "$1" in
    --file|--state-dir|--environment)
      [[ $# -ge 2 && -n "$2" ]] || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in --file) definition_file="$2" ;; --state-dir) state_dir="$2" ;; --environment) environment="$2" ;; esac; shift 2 ;;
    --json) json=true; shift ;; --no-open) no_open=true; shift ;;
    *) echo 'Unknown system option' >&2; exit 2 ;;
  esac
done
case "$action" in
  help|--help) printf '%s\n' 'Werk Docker system (mock): plan | setup | up | start | status | doctor | stop | credentials' 'Options: --file definition.yaml --state-dir PATH --environment docker --json --no-open'; exit 0 ;;
  plan|setup|up|start|status|doctor|stop|credentials) ;;
  *) echo 'Unknown system command' >&2; exit 2 ;;
esac
[[ -z "$environment" || "$environment" == docker ]] || { echo 'Docker launcher requires --environment docker' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker with Compose is required; host Node is not required.' >&2; exit 1; }
docker compose version >/dev/null
[[ "$release_dir" != *','* && "$release_dir" != *$'\n'* ]] || { echo 'Release path cannot contain commas or line breaks' >&2; exit 2; }
helper=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" --mount "type=bind,source=$release_dir,target=/release,readonly")
# Bash 3 nounset requires conditional expansion for an empty optional array.
helper_options=()
if [[ -n "$definition_file" ]]; then
  [[ -f "$definition_file" && ! -L "$definition_file" ]] || { echo 'Definition must be a regular YAML file' >&2; exit 2; }
  definition_file="$(cd -- "$(dirname -- "$definition_file")" && pwd -P)/${definition_file##*/}"
  [[ "$definition_file" != *','* && "$definition_file" != *$'\n'* ]] || { echo 'Definition path cannot contain commas or line breaks' >&2; exit 2; }
  helper+=(--mount "type=bind,source=$definition_file,target=/definition.yaml,readonly")
  helper_options+=(--file /definition.yaml)
  if [[ -n "$environment" ]]; then helper_options+=(--environment "$environment"); fi
fi
base_image="${WERK_DOCKER_BASE_IMAGE:-node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df}"
if [[ "$action" == plan ]]; then
  [[ -n "$definition_file" ]] || { echo 'system plan requires --file' >&2; exit 2; }
  "${helper[@]}" --entrypoint node "$base_image" /release/scripts/docker/system.mjs plan ${helper_options[@]+"${helper_options[@]}"}
  exit 0
fi
if [[ -n "$definition_file" ]]; then
  system_id="$("${helper[@]}" --entrypoint node "$base_image" /release/scripts/docker/system.mjs id ${helper_options[@]+"${helper_options[@]}"})"
fi
if [[ -z "$state_dir" ]]; then
  [[ -n "$definition_file" ]] || { echo 'Specify --file or --state-dir' >&2; exit 2; }
  [[ "$system_id" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || { echo 'Invalid system identity' >&2; exit 2; }
  state_dir="$release_dir/.werk-system/$system_id"
fi
if [[ "$action" == setup || "$action" == up ]]; then mkdir -p -- "$state_dir"; fi
[[ -d "$state_dir" && ! -L "$state_dir" ]] || { echo 'System state missing or linked; run system setup' >&2; exit 1; }
state_dir="$(cd -- "$state_dir" && pwd -P)"
[[ "$state_dir" != *','* && "$state_dir" != *$'\n'* && "$state_dir" != *$'\r'* ]] || { echo 'State path cannot contain commas or line breaks' >&2; exit 2; }
helper+=(--mount "type=bind,source=$state_dir,target=/state")
helper+=(--entrypoint node "$base_image" /release/scripts/docker/system.mjs)
if [[ "$action" == setup || "$action" == up ]]; then
  setup_options=(--host-state "$state_dir" --uid "$(id -u)" --gid "$(id -g)")
  if [[ -n "${WERK_DOCKER_IMAGE:-}" ]]; then setup_options+=(--image "$WERK_DOCKER_IMAGE"); fi
  setup_result="$("${helper[@]}" setup ${helper_options[@]+"${helper_options[@]}"} "${setup_options[@]}")"
  IFS= read -r image < "$state_dir/docker-image"
  docker build --file "$release_dir/Dockerfile.release" --tag "$image" "$release_dir" >&2
  if [[ "$action" == setup ]]; then printf '%s\n' "$setup_result"; exit 0; fi
fi
for metadata in docker-project docker-compose.json docker-image; do
  [[ -f "$state_dir/$metadata" && ! -L "$state_dir/$metadata" ]] || { echo 'Docker system metadata missing or linked; run setup' >&2; exit 1; }
done
IFS= read -r project < "$state_dir/docker-project"
[[ "$project" =~ ^werk-system-[a-f0-9]{16}$ ]] || { echo 'Invalid Docker system project' >&2; exit 1; }
compose=(docker compose --project-directory "$release_dir" --file "$state_dir/docker-compose.json" --project-name "$project")
if [[ "$action" == start || ( -n "$definition_file" && "$action" != up ) ]]; then "${helper[@]}" verify ${helper_options[@]+"${helper_options[@]}"} >/dev/null; fi
if [[ "$action" == start ]]; then
  IFS= read -r image < "$state_dir/docker-image"
  docker build --file "$release_dir/Dockerfile.release" --tag "$image" "$release_dir" >&2
fi
case "$action" in
  up|start)
    if ! "${compose[@]}" up --detach --wait --wait-timeout 120 >&2; then
      printf 'System start incomplete; state and any running services were preserved. Inspect system status or run system stop --state-dir "%s".\n' "$state_dir" >&2; exit 1
    fi
    if ! "${compose[@]}" exec -T factory node /app/scripts/docker/system.mjs bootstrap; then
      printf 'System registration/readiness incomplete; running services and state were preserved. Inspect system status or run system stop --state-dir "%s".\n' "$state_dir" >&2; exit 1
    fi
    if [[ "$no_open" == false && "$json" == false ]]; then
      url="$("${compose[@]}" exec -T factory node /app/scripts/docker/system.mjs url)"
      if command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then xdg-open "$url" >/dev/null 2>&1 || printf 'Open %s\n' "$url" >&2
      elif command -v open >/dev/null; then open "$url" >/dev/null 2>&1 || printf 'Open %s\n' "$url" >&2
      else printf 'Open %s\n' "$url" >&2; fi
    fi ;;
  status|doctor)
    running="$("${compose[@]}" ps --status running --services)"
    if [[ $'\n'"$running"$'\n' == *$'\nfactory\n'* ]]; then "${compose[@]}" exec -T factory node /app/scripts/docker/system.mjs "$action"
    else "${helper[@]}" "$action"; fi ;;
  stop)
    service_names="$("${helper[@]}" services)"
    while IFS= read -r service; do "${compose[@]}" stop --timeout 20 "$service" >&2; done <<< "$service_names"
    printf '%s\n' '{"stopped":true,"statePreserved":true}' ;;
  credentials) "${helper[@]}" credentials --host-state "$state_dir" ;;
esac
