#!/usr/bin/env bash

# Desktop App Release Script
# Based on apps/desktop/RELEASE.md
#
# Usage:
#   ./create-release.sh [version]
#   Example: ./create-release.sh              # Interactive version selection
#   Example: ./create-release.sh 0.0.1        # Explicit version
#
# This script will:
# 1. Prompt for version if not provided (patch/minor/major/custom)
# 2. Verify prerequisites (clean git, GitHub CLI authenticated)
# 3. Optionally rebuild an unpublished draft; published versions are immutable
# 4. Update package.json version
# 5. Push the version commit from main
# 6. Create and push a git tag to trigger the release workflow
# 7. Monitor the GitHub Actions workflow in real-time
# 8. Leave the signed release as a draft for manual review and promotion
#
# Features:
# - Interactive version selection with patch/minor/major options
# - Supports rebuilding an unpublished draft without replacing a published version
# - Draft by default for review before publishing
# - Stable tags use the exact vMAJOR.MINOR.PATCH format
# - Publishing is deliberately a separate, manual action
#
# Requirements:
# - GitHub CLI (gh) installed and authenticated
# - Clean working directory
# - Running from monorepo root

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}ℹ ${NC}$1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

# Semver increment functions
increment_patch() {
    local version="$1"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    echo "${major}.${minor}.$((patch + 1))"
}

increment_minor() {
    local version="$1"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    echo "${major}.$((minor + 1)).0"
}

increment_major() {
    local version="$1"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    echo "$((major + 1)).0.0"
}

# Parse arguments
VERSION=""

for arg in "$@"; do
    case $arg in
        -*)
            error "Unknown option: $arg\nUsage: $0 [version]"
            ;;
        *)
            if [ -z "$VERSION" ]; then
                VERSION="$arg"
            else
                error "Unexpected argument: $arg\nUsage: $0 [version]"
            fi
            ;;
    esac
done

# If no version provided, prompt user to select
if [ -z "$VERSION" ]; then
    # Check if we're in the monorepo root first
    if [ ! -f "package.json" ] || [ ! -d "apps/desktop" ]; then
        error "Please run this script from the monorepo root directory"
    fi

    # Fetch the latest desktop release version from GitHub
    # Stable desktop releases use tags like "v0.4.0".
    LATEST_TAG=$(gh release list --limit 100 --json tagName --jq '[.[] | select(.tagName | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | sort_by(.tagName | ltrimstr("v") | split(".") | map(tonumber)) | last | .tagName // ""' 2>/dev/null || echo "")
    if [ -n "$LATEST_TAG" ]; then
        # Extract version from tag (e.g., "v0.4.0" -> "0.4.0")
        CURRENT_VERSION="${LATEST_TAG#v}"
    else
        # Fallback to local package.json if no releases exist yet
        warn "No existing desktop releases found. Using local package.json version."
        CURRENT_VERSION=$(node -p "require('./apps/desktop/package.json').version")
    fi
    PATCH_VERSION=$(increment_patch "$CURRENT_VERSION")
    MINOR_VERSION=$(increment_minor "$CURRENT_VERSION")
    MAJOR_VERSION=$(increment_major "$CURRENT_VERSION")

    echo ""
    echo -e "${BLUE}Current version:${NC} ${CURRENT_VERSION}"
    echo ""
    echo "Select the new version:"
    echo -e "  1) Patch  ${GREEN}${PATCH_VERSION}${NC} (bug fixes)"
    echo -e "  2) Minor  ${GREEN}${MINOR_VERSION}${NC} (new features, backward compatible)"
    echo -e "  3) Major  ${GREEN}${MAJOR_VERSION}${NC} (breaking changes)"
    echo "  4) Custom (enter manually)"
    echo ""
    read -p "Enter choice [1-4]: " version_choice

    case $version_choice in
        1)
            VERSION="$PATCH_VERSION"
            ;;
        2)
            VERSION="$MINOR_VERSION"
            ;;
        3)
            VERSION="$MAJOR_VERSION"
            ;;
        4)
            read -p "Enter version (e.g., 1.2.3): " VERSION
            if [ -z "$VERSION" ]; then
                error "Version cannot be empty"
            fi
            # Validate semver format
            if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                error "Invalid version format. Expected: MAJOR.MINOR.PATCH (e.g., 1.2.3)"
            fi
            ;;
        *)
            error "Invalid choice. Please enter 1, 2, 3, or 4."
            ;;
    esac

    echo ""
    info "Selected version: ${VERSION}"
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "Invalid version format. Expected: MAJOR.MINOR.PATCH (e.g., 1.2.3)"
fi

TAG_NAME="v${VERSION}"
DESKTOP_DIR="apps/desktop"

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    error "GitHub CLI (gh) is required but not installed.\nInstall it from: https://cli.github.com/"
fi

# Check if jq is installed (required for package.json version updates)
if ! command -v jq &> /dev/null; then
    error "jq is required but not installed.\nInstall it with your package manager (e.g. sudo apt install jq)"
fi

# Check if authenticated with gh
if ! gh auth status &> /dev/null; then
    error "Not authenticated with GitHub CLI.\nRun: gh auth login"
fi

info "Starting release process for version ${VERSION}"
echo ""

# Check if we're in the monorepo root
if [ ! -f "package.json" ] || [ ! -d "apps/desktop" ]; then
    error "Please run this script from the monorepo root directory"
fi

if [ -n "$(git status --porcelain)" ]; then
    error "The working tree must be clean before creating a stable release"
fi

if [ "$(git branch --show-current)" != "main" ]; then
    error "Stable releases must be created from the main branch"
fi

git fetch --no-tags origin main:refs/remotes/origin/main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    error "Local main must exactly match origin/main before creating a stable release"
fi

# Navigate to desktop app directory
cd "${DESKTOP_DIR}"

# 1. Check if tag/release already exists
info "Checking if tag ${TAG_NAME} already exists..."
if git rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
    echo ""
    warn "Tag ${TAG_NAME} already exists!"

    # Check if there's also a GitHub release
    if gh release view "${TAG_NAME}" &>/dev/null; then
        RELEASE_IS_DRAFT=$(gh release view "${TAG_NAME}" --json isDraft --jq '.isDraft')
        RELEASE_STATUS=$([ "$RELEASE_IS_DRAFT" = "true" ] && echo "draft" || echo "published")
        echo -e "  GitHub release: ${YELLOW}${RELEASE_STATUS}${NC}"
        if [ "$RELEASE_IS_DRAFT" != "true" ]; then
            error "Published releases are immutable. Create a new patch version instead of replacing ${TAG_NAME}."
        fi
    else
        error "Existing tag ${TAG_NAME} is not attached to a draft release; refusing automated deletion"
    fi
    echo ""

    # Ask user what to do
    echo "What would you like to do?"
    echo "  1) Rebuild draft - Delete the unpublished draft/tag and create it again"
    echo "  2) Cancel - Exit without changes"
    echo ""
    read -p "Enter choice [1-2]: " choice

    case $choice in
        1)
            info "Cleaning up unpublished draft..."

            # Re-check immediately before deletion and fail closed on API errors.
            RELEASE_IS_DRAFT=$(gh release view "${TAG_NAME}" --json isDraft --jq '.isDraft')
            if [ "$RELEASE_IS_DRAFT" != "true" ]; then
                error "Refusing to delete published release ${TAG_NAME}; create a new patch version"
            fi
            info "Deleting existing draft release..."
            gh release delete "${TAG_NAME}" --yes
            success "Deleted existing draft release"

            # Delete remote tag
            info "Deleting remote tag..."
            git push origin --delete "${TAG_NAME}" 2>/dev/null || true
            success "Deleted remote tag"

            # Delete local tag
            info "Deleting local tag..."
            git tag -d "${TAG_NAME}" 2>/dev/null || true
            success "Deleted local tag"
            ;;
        2|*)
            info "Cancelled. No changes made."
            exit 0
            ;;
    esac
fi
success "Tag ${TAG_NAME} is available"

# 3. Update version in package.json
info "Updating version in package.json..."
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "${CURRENT_VERSION}" == "${VERSION}" ]; then
    warn "package.json already has version ${VERSION}"
else
    # Update the version using jq to handle workspace dependencies
    TMP_FILE=$(mktemp)
    jq ".version = \"${VERSION}\"" package.json > "${TMP_FILE}" && mv "${TMP_FILE}" package.json
    # Format package.json to match project conventions (jq reformats the JSON)
    bunx biome format --write package.json
    (cd ../.. && bun install --lockfile-only)
    success "Updated package.json from ${CURRENT_VERSION} to ${VERSION}"

    # Commit the workspace version and matching frozen-install lockfile.
    git add package.json ../../bun.lock
    git commit -m "chore(desktop): bump version to ${VERSION}"
    success "Committed version change"
fi

# 4. Push the version commit
info "Pushing changes to remote..."
CURRENT_BRANCH=$(git branch --show-current)
git push -u origin "HEAD:${CURRENT_BRANCH}"
success "Changes pushed to ${CURRENT_BRANCH}"

# 5. Create and push tag
info "Creating tag ${TAG_NAME}..."
git tag "${TAG_NAME}"
success "Tag ${TAG_NAME} created"

info "Pushing tag to trigger release workflow..."
git push origin "${TAG_NAME}"
success "Tag pushed to remote"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🎉 Release process initiated successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Get repository information
REPO=$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')

# 6. Monitor the workflow
info "Monitoring GitHub Actions workflow..."
echo "  Waiting for workflow to start (this may take a few seconds)..."
TAG_SHA=$(git rev-list -n 1 "${TAG_NAME}")

# Wait and retry to find the workflow run
MAX_RETRIES=6
RETRY_COUNT=0
WORKFLOW_RUN=""

while [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ -z "$WORKFLOW_RUN" ]; do
    sleep 5
    WORKFLOW_RUN=$(gh run list \
        --workflow=release-desktop.yml \
        --json databaseId,headSha,event,createdAt \
        --jq ".[] | select(.headSha == \"${TAG_SHA}\" and .event == \"push\") | .databaseId" \
        | head -1)
    RETRY_COUNT=$((RETRY_COUNT + 1))

    if [ -z "$WORKFLOW_RUN" ] && [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        echo "  Still waiting... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    fi
done

if [ -z "$WORKFLOW_RUN" ]; then
    warn "Could not find workflow run automatically"
    echo "  Manual monitoring URL:"
    echo "  https://github.com/${REPO}/actions"
    echo ""
    warn "The workflow may still be starting. Check the URL above in a few moments."
else
    success "Found workflow run: ${WORKFLOW_RUN}"
    echo ""
    info "Watching workflow progress..."
    echo "  View in browser: https://github.com/${REPO}/actions/runs/${WORKFLOW_RUN}"
    echo ""

    # Watch the workflow (this will stream the status)
    gh run watch "${WORKFLOW_RUN}" || warn "Workflow monitoring interrupted"

    # Check final status
    WORKFLOW_STATUS=$(gh run view "${WORKFLOW_RUN}" --json conclusion --jq .conclusion)

    if [ "$WORKFLOW_STATUS" == "success" ]; then
        success "Workflow completed successfully!"
    elif [ "$WORKFLOW_STATUS" == "failure" ]; then
        error "Workflow failed. Please check the logs at: https://github.com/${REPO}/actions/runs/${WORKFLOW_RUN}"
    else
        warn "Workflow ended with status: ${WORKFLOW_STATUS}"
    fi
fi

echo ""

# 7. Wait for the draft release
info "Waiting for draft release to be created..."

# Retry logic for draft release (it may take time to be created)
MAX_RELEASE_RETRIES=10
RELEASE_RETRY_COUNT=0
RELEASE_FOUND=""

while [ $RELEASE_RETRY_COUNT -lt $MAX_RELEASE_RETRIES ] && [ -z "$RELEASE_FOUND" ]; do
    sleep 3
    RELEASE_FOUND=$(gh release list --json tagName,isDraft --jq ".[] | select(.tagName == \"${TAG_NAME}\") | .tagName")
    RELEASE_RETRY_COUNT=$((RELEASE_RETRY_COUNT + 1))

    if [ -z "$RELEASE_FOUND" ] && [ $RELEASE_RETRY_COUNT -lt $MAX_RELEASE_RETRIES ]; then
        echo "  Waiting for release to be created... (attempt $RELEASE_RETRY_COUNT/$MAX_RELEASE_RETRIES)"
    fi
done

if [ -z "$RELEASE_FOUND" ]; then
    warn "Release not found yet. It may still be processing."
    echo "  Check releases at: https://github.com/${REPO}/releases"
else
    RELEASE_URL="https://github.com/${REPO}/releases/tag/${TAG_NAME}"
    success "Draft release created!"

    echo ""
    echo -e "${BLUE}Review URL:${NC} ${RELEASE_URL}"
    echo ""
    echo "After verifying signatures, checksums, release notes, and installers, promote it manually:"
    echo "  gh release edit ${TAG_NAME} --draft=false"
    echo ""
fi
