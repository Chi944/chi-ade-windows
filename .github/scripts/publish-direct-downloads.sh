#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${ADE_VERSION:?ADE_VERSION is required}"

RELEASE_TAG="personal-latest"
RELEASE_DIR="${RELEASE_DIR:-release-assets}"
RUN_KEY="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

STABLE_FILES=(
  "ADE-Windows-x64.exe"
  "ADE-macOS-Apple-Silicon.dmg"
  "ADE-macOS-Intel.dmg"
  "SHA256SUMS.txt"
)

declare -A NEXT_NAMES=()
declare -A OLD_NAMES=()
declare -A OLD_IDS=()
declare -A NEXT_IDS=()

for file in "${STABLE_FILES[@]}"; do
  test -f "$RELEASE_DIR/$file" || {
    echo "::error::Missing release file $file"
    exit 1
  }
  stem="${file%.*}"
  extension="${file##*.}"
  NEXT_NAMES["$file"]="${stem}.next-${RUN_KEY}.${extension}"
  OLD_NAMES["$file"]="${stem}.old-${RUN_KEY}.${extension}"
done

release_json() {
  local release_id
  release_id=$(gh release view "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --json databaseId \
    --jq '.databaseId')
  gh api "repos/$GITHUB_REPOSITORY/releases/$release_id"
}

asset_field() {
  local json="$1"
  local name="$2"
  local field="$3"
  jq -r --arg name "$name" ".assets[] | select(.name == \$name) | .$field" <<< "$json"
}

verify_remote_asset() {
  local json="$1"
  local remote_name="$2"
  local local_file="$3"
  local local_size local_digest remote_size remote_digest remote_state

  local_size=$(stat -c '%s' "$local_file")
  local_digest="sha256:$(sha256sum "$local_file" | cut -d ' ' -f 1)"
  remote_size=$(asset_field "$json" "$remote_name" size)
  remote_digest=$(asset_field "$json" "$remote_name" digest)
  remote_state=$(asset_field "$json" "$remote_name" state)

  test "$remote_state" = "uploaded" || {
    echo "::error::$remote_name is not in the uploaded state"
    return 1
  }
  test "$remote_size" = "$local_size" || {
    echo "::error::$remote_name size does not match the validated file"
    return 1
  }
  test "$remote_digest" = "$local_digest" || {
    echo "::error::$remote_name digest does not match the validated file"
    return 1
  }
}

verify_exact_inventory() {
  local json="$1"
  local expected actual
  expected=$(printf '%s\n' "${STABLE_FILES[@]}" | sort)
  actual=$(jq -r '.assets[].name' <<< "$json" | sort)
  test "$actual" = "$expected" || {
    echo "::error::Release has an unexpected asset inventory"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") || true
    return 1
  }
}

verify_stable_assets() {
  local json="$1"
  local file
  for file in "${STABLE_FILES[@]}"; do
    verify_remote_asset "$json" "$file" "$RELEASE_DIR/$file"
  done
}

verify_anonymous_links() {
  local file attempt available
  for file in "${STABLE_FILES[@]}"; do
    available=false
    for attempt in 1 2 3 4 5 6; do
      if curl --fail --silent --show-error --location --head \
        "https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/$file" \
        > /dev/null; then
        available=true
        break
      fi
      sleep $((attempt * 5))
    done
    test "$available" = "true" || {
      echo "::error::Public download did not become available: $file"
      return 1
    }
  done
}

release_body() {
  cat <<EOF
Validated unsigned build from \`$GITHUB_SHA\`.

## Download

- [Windows 10/11 x64](https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/ADE-Windows-x64.exe)
- [macOS Apple Silicon](https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/ADE-macOS-Apple-Silicon.dmg)
- [macOS Intel](https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/ADE-macOS-Intel.dmg)

These installers passed typecheck, focused path-safety tests, compile, native-runtime smoke, package-footprint, signature-state, and checksum validation. They are unsigned, so Windows SmartScreen or macOS Gatekeeper may ask for confirmation. See the [install guide](https://github.com/$GITHUB_REPOSITORY/blob/main/docs/personal-install.md).

This rolling prerelease is excluded from ADE's signed stable update feed.

Build log: https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID
EOF
}

update_release_metadata() {
  gh release edit "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --draft=false \
    --prerelease \
    --latest=false \
    --title "ADE $ADE_VERSION Direct Downloads" \
    --notes "$(release_body)"
}

publish_first_release() {
  local created=false published=false json

  cleanup_failed_draft() {
    local status=$?
    trap - EXIT
    if test "$status" -ne 0 && test "$created" = "true" && test "$published" = "false"; then
      gh release delete "$RELEASE_TAG" \
        --repo "$GITHUB_REPOSITORY" \
        --yes || true
    fi
    exit "$status"
  }
  trap cleanup_failed_draft EXIT

  gh release create "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --draft \
    --prerelease \
    --latest=false \
    --verify-tag \
    --title "ADE $ADE_VERSION Direct Downloads" \
    --notes "$(release_body)"
  created=true

  gh release upload "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    "${STABLE_FILES[@]/#/$RELEASE_DIR/}"

  json=$(release_json)
  test "$(jq -r '.draft' <<< "$json")" = "true"
  test "$(jq -r '.prerelease' <<< "$json")" = "true"
  verify_exact_inventory "$json"
  verify_stable_assets "$json"

  update_release_metadata
  published=true
  verify_anonymous_links

  trap - EXIT
}

cleanup_local_next_files() {
  local file
  for file in "${STABLE_FILES[@]}"; do
    rm -f "$RELEASE_DIR/${NEXT_NAMES[$file]}"
  done
}

asset_name() {
  local asset_id="$1"
  gh api \
    "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" \
    --jq '.name' 2>/dev/null
}

rename_asset_with_retry() {
  local asset_id="$1"
  local desired_name="$2"
  local attempt
  for attempt in 1 2 3; do
    if gh api \
      --method PATCH \
      "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" \
      -f name="$desired_name" \
      --silent && test "$(asset_name "$asset_id")" = "$desired_name"; then
      return 0
    fi
    sleep $((attempt * 2))
  done
  return 1
}

rollback_assets() {
  local index file old_current next_current stable_current rollback_failed=false
  set +e

  for ((index=${#STABLE_FILES[@]} - 1; index >= 0; index--)); do
    file="${STABLE_FILES[$index]}"
    test -n "${OLD_IDS[$file]:-}" || continue
    test -n "${NEXT_IDS[$file]:-}" || continue

    next_current=$(gh api \
      "repos/$GITHUB_REPOSITORY/releases/assets/${NEXT_IDS[$file]}" \
      --jq '.name' 2>/dev/null)
    old_current=$(gh api \
      "repos/$GITHUB_REPOSITORY/releases/assets/${OLD_IDS[$file]}" \
      --jq '.name' 2>/dev/null)

    if test "$next_current" = "$file" && test "$old_current" != "$file"; then
      if rename_asset_with_retry "${NEXT_IDS[$file]}" "${NEXT_NAMES[$file]}"; then
        if ! rename_asset_with_retry "${OLD_IDS[$file]}" "$file"; then
          rename_asset_with_retry "${NEXT_IDS[$file]}" "$file" || true
        fi
      fi
    elif test "$old_current" != "$file" && test "$next_current" != "$file"; then
      if ! rename_asset_with_retry "${OLD_IDS[$file]}" "$file"; then
        rename_asset_with_retry "${NEXT_IDS[$file]}" "$file" || true
      fi
    fi

    old_current=$(asset_name "${OLD_IDS[$file]}")
    next_current=$(asset_name "${NEXT_IDS[$file]}")
    stable_current=false
    if test "$old_current" = "$file" || test "$next_current" = "$file"; then
      stable_current=true
    fi
    if test "$stable_current" != "true"; then
      echo "::error::Rollback could not restore a live stable asset for $file"
      rollback_failed=true
    fi
  done

  test "$rollback_failed" = "false"
}

delete_next_assets() {
  local file json next_id old_id next_current old_current
  set +e
  json=$(release_json 2>/dev/null)
  for file in "${STABLE_FILES[@]}"; do
    next_id="${NEXT_IDS[$file]:-}"
    if test -z "$next_id" && test -n "$json"; then
      next_id=$(asset_field "$json" "${NEXT_NAMES[$file]}" id)
    fi
    test -n "$next_id" && test "$next_id" != "null" || continue
    old_id="${OLD_IDS[$file]:-}"
    test -n "$old_id" && test "$old_id" != "null" || continue

    next_current=$(gh api \
      "repos/$GITHUB_REPOSITORY/releases/assets/$next_id" \
      --jq '.name' 2>/dev/null)
    old_current=$(gh api \
      "repos/$GITHUB_REPOSITORY/releases/assets/$old_id" \
      --jq '.name' 2>/dev/null)

    if test "$next_current" = "${NEXT_NAMES[$file]}" && test "$old_current" = "$file"; then
      gh api \
        --method DELETE \
        "repos/$GITHUB_REPOSITORY/releases/assets/$next_id" \
        --silent || true
    else
      echo "::error::Rollback could not be proven for $file; retaining both assets for manual recovery"
    fi
  done
}

update_existing_release() {
  local json file old_id next_id
  local -a next_paths=()

  json=$(release_json)
  test "$(jq -r '.draft' <<< "$json")" = "false" || {
    echo "::error::$RELEASE_TAG is an unexpected draft"
    return 1
  }
  test "$(jq -r '.prerelease' <<< "$json")" = "true" || {
    echo "::error::$RELEASE_TAG must remain a prerelease"
    return 1
  }
  verify_exact_inventory "$json"

  for file in "${STABLE_FILES[@]}"; do
    old_id=$(asset_field "$json" "$file" id)
    test -n "$old_id" && test "$old_id" != "null"
    OLD_IDS["$file"]="$old_id"
    cp --reflink=auto \
      "$RELEASE_DIR/$file" \
      "$RELEASE_DIR/${NEXT_NAMES[$file]}"
    next_paths+=("$RELEASE_DIR/${NEXT_NAMES[$file]}")
  done

  cleanup_failed_update() {
    local status=$?
    trap - EXIT
    if test "$status" -ne 0; then
      rollback_assets
      delete_next_assets
    fi
    cleanup_local_next_files
    exit "$status"
  }
  trap cleanup_failed_update EXIT

  gh release upload "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    "${next_paths[@]}"

  json=$(release_json)
  for file in "${STABLE_FILES[@]}"; do
    next_id=$(asset_field "$json" "${NEXT_NAMES[$file]}" id)
    test -n "$next_id" && test "$next_id" != "null"
    NEXT_IDS["$file"]="$next_id"
    verify_remote_asset \
      "$json" \
      "${NEXT_NAMES[$file]}" \
      "$RELEASE_DIR/$file"
  done

  for file in "${STABLE_FILES[@]}"; do
    gh api \
      --method PATCH \
      "repos/$GITHUB_REPOSITORY/releases/assets/${OLD_IDS[$file]}" \
      -f name="${OLD_NAMES[$file]}" \
      --silent
    if ! gh api \
      --method PATCH \
      "repos/$GITHUB_REPOSITORY/releases/assets/${NEXT_IDS[$file]}" \
      -f name="$file" \
      --silent; then
      gh api \
        --method PATCH \
        "repos/$GITHUB_REPOSITORY/releases/assets/${OLD_IDS[$file]}" \
        -f name="$file" \
        --silent || true
      return 1
    fi
  done

  json=$(release_json)
  verify_stable_assets "$json"
  verify_anonymous_links

  trap - EXIT
  for file in "${STABLE_FILES[@]}"; do
    gh api \
      --method DELETE \
      "repos/$GITHUB_REPOSITORY/releases/assets/${OLD_IDS[$file]}" \
      --silent
  done
  cleanup_local_next_files

  update_release_metadata

  json=$(release_json)
  verify_exact_inventory "$json"
  verify_stable_assets "$json"
}

if existing_release=$(release_json 2>/dev/null); then
  if test "$(jq -r '.draft' <<< "$existing_release")" = "true"; then
    gh release delete "$RELEASE_TAG" \
      --repo "$GITHUB_REPOSITORY" \
      --yes
    publish_first_release
  else
    update_existing_release
  fi
else
  publish_first_release
fi

echo "Published and verified $RELEASE_TAG for $GITHUB_SHA"
