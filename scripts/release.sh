#!/usr/bin/env bash
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$#" -le 1 ] || fail 'Usage: release.sh [TAG]'
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
cd "$project_root"
for command in git gh; do command -v "$command" >/dev/null 2>&1 || fail "Missing command: $command"; done
[ "$(git branch --show-current)" = main ] || fail 'Release from a main checkout, not a detached HEAD or another branch.'
[ -z "$(git --no-optional-locks status --porcelain)" ] || fail 'Checkout must be clean before releasing.'
case "$(git remote get-url origin)" in
    https://github.com/inwonakng/pi-console|https://github.com/inwonakng/pi-console.git|git@github.com:inwonakng/pi-console.git|ssh://git@github.com/inwonakng/pi-console.git) ;;
    *) fail 'Origin must be the inwonakng/pi-console GitHub repository.' ;;
esac

# Fetch only observes the remote and updates local remote/tag refs. Publishing
# starts only after the explicit confirmation below.
git fetch --quiet origin main --tags
commit=$(git rev-parse HEAD)
[ "$commit" = "$(git rev-parse FETCH_HEAD)" ] || fail 'Local main must exactly match origin main. Sync it before releasing.'

prefix="v$(date +%Y.%m.%d)."
remote_tags=$(git ls-remote --tags origin "refs/tags/$prefix*")
local_tags=$(git tag --list "$prefix*")
max=0
while IFS= read -r tag; do
    case "$tag" in
        "$prefix"*)
            number=${tag#"$prefix"}
            case "$number" in ''|*[!0-9]*) continue ;; esac
            # Date counters are decimal; ignore unrelated/malformed tag suffixes.
            [ "${#number}" -le 8 ] || continue
            number=$((10#$number))
            if [ "$number" -gt "$max" ]; then max=$number; fi ;;
    esac
done <<EOF
$local_tags
$(printf '%s\n' "$remote_tags" | awk '{ sub(/^refs\/tags\//, "", $2); sub(/\^\{\}$/, "", $2); print $2 }')
EOF
suggested="$prefix$((max + 1))"
tag=${1:-}
if [ -z "$tag" ]; then
    printf 'Version [%s]: ' "$suggested"
    IFS= read -r tag || fail 'Release cancelled.'
    tag=${tag:-$suggested}
fi
[[ "$tag" =~ ^v[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[1-9][0-9]*$ ]] \
    || fail 'Release tags must use vYYYY.MM.DD.N (N starts at 1).'
git check-ref-format "refs/tags/$tag" || fail 'Invalid release tag.'
if git show-ref --verify --quiet "refs/tags/$tag"; then
    fail "Tag already exists locally: $tag (tags are immutable)."
else
    status=$?
    [ "$status" -eq 1 ] || exit "$status"
fi
existing_remote=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
[ -z "$existing_remote" ] || fail "Tag already exists remotely: $tag (tags are immutable)."
printf 'Commit:    %s\nSuggested: %s\nPublish:   %s\n' "$commit" "$suggested" "$tag"
printf 'This creates an annotated tag, pushes it, and publishes the latest GitHub Release.\n'
printf 'It does not publish npm packages or update any stable installation.\n'
printf 'Publish %s? [y/N] ' "$tag"
IFS= read -r answer || fail 'Release cancelled.'
case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) fail 'Release cancelled.' ;;
esac
# Recheck local state after confirmation; never tag changes made while prompting.
[ -z "$(git --no-optional-locks status --porcelain)" ] && [ "$(git rev-parse HEAD)" = "$commit" ] \
    && [ "$(git branch --show-current)" = main ] || fail 'Checkout changed during confirmation.'
git tag -a "$tag" "$commit" -m "pi-console $tag"
git push origin "refs/tags/$tag"
gh release create "$tag" --repo inwonakng/pi-console --verify-tag --latest --generate-notes
printf 'Published %s at %s. Stable installations were not changed.\n' "$tag" "$commit"
