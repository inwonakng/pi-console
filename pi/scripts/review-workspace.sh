#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
	printf 'Usage: bash %s <worktree> <baseline-commit>\n' "$0" >&2
	exit 2
fi

worktree=$1
baseline=$2

if [[ ! -d $worktree ]]; then
	printf 'Workspace does not exist: %s\n' "$worktree" >&2
	exit 1
fi

baseline_commit=$(git -C "$worktree" rev-parse --verify "${baseline}^{commit}")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

cd "$worktree"
unset NVIM NVIM_LISTEN_ADDRESS NVIM_APPNAME
export PI_WORKSPACE_BASELINE=$baseline_commit
export PI_WORKSPACE_REVIEW_LUA="$script_dir/review-workspace.lua"
NVIM_NO_PERSISTENCE=1 nvim -c "lua dofile(vim.env.PI_WORKSPACE_REVIEW_LUA)"
