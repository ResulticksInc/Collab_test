#!/usr/bin/env bash

set -euo pipefail

# Retry wrapper for network calls (clone / switch / push)
retry() {
  local n=1 max=3 delay=15
  until "$@"; do
    if (( n == max )); then
      echo "ERROR: command failed after $n attempts: $*" >&2
      return 1
    fi
    echo "== Attempt $n/$max failed, retrying in ${delay}s: $*"
    sleep "$delay"
    n=$((n + 1))
  done
}

AZURE_SRC_DIR="${AZURE_SRC_DIR:-$(pwd)}"
AZURE_COMMIT="$(git -C "$AZURE_SRC_DIR" rev-parse HEAD)"
GITU_WORKDIR="$(mktemp -d /tmp/gitu-sync.XXXXXX)"
DEFAULT_BASE_BRANCH="${GITU_BASE_BRANCH:-main}"
# Every run gets a NEW Gitu branch named by date (IST), e.g. sync12oct,
# then sync12oct-set1, sync12oct-set2 ... for further runs on the same day.
GITU_BRANCH_PREFIX="${GITU_BRANCH_PREFIX:-sync}"
DATE_TAG="$(TZ=Asia/Kolkata date +%d%b | tr '[:upper:]' '[:lower:]')"
BRANCH_BASE_NAME="${GITU_BRANCH_PREFIX}${DATE_TAG}"
GITU_TARGET_BRANCH="$BRANCH_BASE_NAME"   # final name decided in step 2

# Files larger than this are skipped (resulgit is Node-based and cannot
# handle files near/over ~512 MB: "Cannot create a string longer than 0x1fffffe8").
MAX_FILE_MB="${MAX_FILE_MB:-200}"
MAX_BYTES=$((MAX_FILE_MB * 1024 * 1024))

echo "== Azure source:   $AZURE_SRC_DIR"
echo "== Gitu workdir:   $GITU_WORKDIR"
echo "== Target branch:  $AZURE_BRANCH (Azure)"
echo "== Gitu branch:    $BRANCH_BASE_NAME (or next free -setN)"
echo "== Source commit:  $AZURE_COMMIT"
echo "== Max file size:  ${MAX_FILE_MB} MB"

FILELIST="$(mktemp /tmp/gitu-filelist.XXXXXX)"
cleanup() { rm -rf "$GITU_WORKDIR" "$FILELIST"; }
trap cleanup EXIT

# 1. Authenticate against Gitu
echo "== Step 1: authenticate"
resulgit auth set-server --server "$GITU_SERVER"
resulgit auth set-token --token "$GITU_TOKEN"

if ! resulgit repo list >/tmp/repo_list_check.log 2>&1; then
  echo "ERROR: resulgit session isn't working — 'repo list' failed. Check GITU_TOKEN / rotation." >&2
  cat /tmp/repo_list_check.log >&2
  exit 1
fi

# 2. Get (or create) the target branch on Gitu, cloned locally.
echo "== Step 2: clone and prepare branch"
cd "$GITU_WORKDIR"
retry resulgit clone --repo "$GITU_REPO_ID" --branch "$DEFAULT_BASE_BRANCH" --dest repo
cd repo
resulgit workspace set-root --path "$GITU_WORKDIR/repo"

# Find the first free name: sync12oct, sync12oct-set1, sync12oct-set2, ...
set_no=0
created=false
while (( set_no <= 50 )); do
  if (( set_no == 0 )); then
    candidate="$BRANCH_BASE_NAME"
  else
    candidate="${BRANCH_BASE_NAME}-set${set_no}"
  fi

  if resulgit branch create --name "$candidate" --base "$DEFAULT_BASE_BRANCH" 2>/tmp/branch_create_err.log; then
    GITU_TARGET_BRANCH="$candidate"
    created=true
    echo "== Created new branch '$GITU_TARGET_BRANCH' from '$DEFAULT_BASE_BRANCH'."
    break
  elif grep -qi "already exists" /tmp/branch_create_err.log; then
    echo "== Branch '$candidate' already exists, trying next name."
    set_no=$((set_no + 1))
  else
    echo "ERROR: failed to create branch '$candidate':" >&2
    cat /tmp/branch_create_err.log >&2
    exit 1
  fi
done

if [ "$created" != true ]; then
  echo "ERROR: no free branch name found for '$BRANCH_BASE_NAME' (tried up to -set50)." >&2
  exit 1
fi

echo "== Switching to '$GITU_TARGET_BRANCH'"
if ! resulgit switch --branch "$GITU_TARGET_BRANCH"; then
  echo "ERROR: could not switch to Gitu branch '$GITU_TARGET_BRANCH'." >&2
  echo "       The branch was just created from '$DEFAULT_BASE_BRANCH'. If the error above is" >&2
  echo "       'Cannot create a string longer than 0x1fffffe8 characters', then the base branch" >&2
  echo "       '$DEFAULT_BASE_BRANCH' itself holds oversized content on Gitu." >&2
  exit 1
fi

# 3. Mirror only Git-tracked files from Azure (no build output, no untracked
#    junk), skipping any single file larger than MAX_FILE_MB.
echo "== Step 3: build list of tracked files"
included=0
skipped=0
while IFS= read -r -d '' f; do
  case "$f" in
    .azure-pipelines/*) continue ;;
  esac
  # Skip submodule entries / missing paths
  [ -f "$AZURE_SRC_DIR/$f" ] || [ -L "$AZURE_SRC_DIR/$f" ] || continue
  sz=$(stat -c %s "$AZURE_SRC_DIR/$f" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$MAX_BYTES" ]; then
    echo "WARN: skipping large file ($((sz / 1024 / 1024)) MB): $f" >&2
    skipped=$((skipped + 1))
  else
    printf '%s\0' "$f" >> "$FILELIST"
    included=$((included + 1))
  fi
done < <(git -C "$AZURE_SRC_DIR" ls-files -z)

echo "== Tracked files to sync: $included (skipped as too large: $skipped)"

echo "== Clearing old content in Gitu workspace (keeping metadata)"
find "$GITU_WORKDIR/repo" -mindepth 1 -maxdepth 1 \
  ! -name '.vcs-next' ! -name '.git' -exec rm -rf {} +

echo "== Copying files"
rsync -a --from0 --files-from="$FILELIST" "$AZURE_SRC_DIR"/ "$GITU_WORKDIR/repo"/

echo "== Workspace size after copy: $(du -sh --exclude=.vcs-next --exclude=.git "$GITU_WORKDIR/repo" | cut -f1)"

# 4. Stage, and only commit/push if something actually changed
echo "== Step 4: stage changes"
resulgit add --all

echo "== Checking status"
if resulgit status | grep -qE 'nothing to commit|working (directory|tree) clean'; then
  echo "== No changes to sync for branch '$GITU_TARGET_BRANCH'. Skipping commit/push."
  exit 0
fi

COMMIT_MSG="Sync from Azure DevOps [$AZURE_REPO_NAME@$AZURE_BRANCH] commit ${AZURE_COMMIT:0:8}"
echo "== Committing"
resulgit commit --message "$COMMIT_MSG"

echo "== Pushing"
retry resulgit push

if [ "$skipped" -gt 0 ]; then
  echo "== NOTE: $skipped large file(s) were NOT synced — see WARN lines above."
fi
echo "== Synced '$AZURE_BRANCH' (Azure) -> '$GITU_TARGET_BRANCH' (Gitu) successfully."