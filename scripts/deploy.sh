#!/usr/bin/env bash
# Deploy the plugin to a desktop or Android Obsidian vault (POSIX wrapper).
#
# All logic lives in scripts/deploy.mjs so Windows, macOS, Linux and CI share one
# implementation. Directories come from the environment (shell, then .env):
#
#   MINERAL_DEPLOY_WINDOWS_VAULT=/home/me/vault ./scripts/deploy.sh windows
#   MINERAL_DEPLOY_ANDROID_VAULT=mineral ./scripts/deploy.sh android --restart
#
# Any extra arguments are forwarded to scripts/deploy.mjs verbatim.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname -- "$script_dir")"
target="${1:-auto}"
if [ "$target" = "windows" ] || [ "$target" = "android" ]; then
  shift
else
  target="auto"
fi

cd -- "$project_root"
exec node "$script_dir/deploy.mjs" --target "$target" "$@"
