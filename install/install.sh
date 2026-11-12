#!/bin/sh
# Sinos CLI — macOS / Linux Installer / Updater
# Usage:   curl -fsSL https://raw.githubusercontent.com/Hopesy/Sinos/main/install/install.sh | sh
# License: AGPL-3.0-or-later (https://github.com/Hopesy/Sinos/blob/main/LICENSE)

set -e

# Resolve the latest published release directly from the Sinos repository.
# A version is accepted only if this platform's asset is already present.
GITHUB_API="https://api.github.com/repos/Hopesy/Sinos/releases/latest"

# Resolve escape sequences via printf at assignment time so the
# variables hold real ESC bytes. Plain '\033[...m' string literals
# only render when the shell's `echo` interprets backslash escapes
# (sh/dash do, bash does not unless -e). Users piping the script
# through `| bash` would otherwise see literal "\033[0;36m" output.
CYAN=$(printf '\033[0;36m')
GREEN=$(printf '\033[0;32m')
GRAY=$(printf '\033[0;90m')
YELLOW=$(printf '\033[0;33m')
RED=$(printf '\033[0;31m')
RESET=$(printf '\033[0m')

echo ""
echo "  ${CYAN}Sinos CLI Installer${RESET}"
echo "  ${GRAY}────────────────────${RESET}"

OS=$(uname -s)
ARCH=$(uname -m)

# Detect the concrete platform slug used to select this machine's release
# asset. Picking this before the lookup ensures we never advertise a release
# whose installer is unavailable for the current platform.
PLATFORM=""
if [ "$OS" = "Darwin" ]; then
  # macOS ships native builds for both Apple Silicon and Intel since v2.7.6
  # (GitHub Actions exposed a `macos-15-intel` runner in May 2026). Earlier
  # versions only shipped arm64, so Intel users needed Rosetta — that path
  # is gone now.
  case "$ARCH" in
    arm64|aarch64)
      PLATFORM="macos-arm"
      ;;
    x86_64|amd64)
      PLATFORM="macos-intel"
      ;;
    *)
      echo "  ${RED}Unsupported macOS architecture: $ARCH${RESET}"
      echo "  ${YELLOW}Sinos CLI ships arm64 and Intel x64 macOS builds.${RESET}"
      echo "  ${YELLOW}Open an issue: https://github.com/Hopesy/Sinos/issues${RESET}"
      exit 1
      ;;
  esac
elif [ "$OS" = "Linux" ]; then
  # We ship amd64 and arm64 Linux artifacts. Pick the slug based on
  # `uname -m`. Anything outside the two known arch families (armv7,
  # riscv64, ppc64le …) fails fast — without this guard those would
  # request an amd64 asset, get 404, and curl's --retry-all-errors
  # would burn five retry attempts on a request that can never succeed.
  case "$ARCH" in
    x86_64|amd64)
      LINUX_ARCH="amd64"
      ;;
    aarch64|arm64)
      LINUX_ARCH="arm64"
      ;;
    *)
      echo "  ${RED}Unsupported Linux architecture: $ARCH${RESET}"
      echo "  ${YELLOW}Sinos CLI currently ships amd64 and arm64 Linux builds only.${RESET}"
      echo "  ${YELLOW}Open an issue: https://github.com/Hopesy/Sinos/issues${RESET}"
      exit 1
      ;;
  esac
  # Prefer dpkg (.deb on Debian/Ubuntu) → rpm (.rpm on Fedora/RHEL/
  # openSUSE/CentOS) → AppImage (everything else, including Arch /
  # NixOS / minimal containers). Each branch picks the arch-matching
  # platform slug we'll use to match the current release asset.
  if command -v dpkg > /dev/null 2>&1; then
    if [ "$LINUX_ARCH" = "arm64" ]; then
      PLATFORM="linux-arm64-deb"
    else
      PLATFORM="linux-deb"
    fi
  elif command -v rpm > /dev/null 2>&1; then
    if [ "$LINUX_ARCH" = "arm64" ]; then
      PLATFORM="linux-arm64-rpm"
    else
      PLATFORM="linux-rpm"
    fi
  else
    if [ "$LINUX_ARCH" = "arm64" ]; then
      PLATFORM="linux-arm64-appimage"
    else
      PLATFORM="linux-appimage"
    fi
  fi
else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

# Pattern that picks our platform's asset out of the GitHub release.
# Mirrors the matchers in Web-Home/_worker.js — keep the two in sync.
# v1.9.2+ uses platform-labelled filenames (Linux_x64.deb / macOS_arm64.dmg
# / Windows_x64-setup.exe); we OR with the pre-v1.9.2 patterns so the
# Direct GitHub release lookup also resolves older releases that someone might
# manually re-publish.
case "$PLATFORM" in
  macos-arm)            ASSET_GREP='(macOS_arm64|aarch64[^\"]*)\.dmg' ;;
  macos-intel)          ASSET_GREP='(macOS_x64|_x64)\.dmg' ;;
  linux-deb)            ASSET_GREP='(Linux_x64|amd64)\.deb' ;;
  linux-rpm)            ASSET_GREP='(Linux_x64\.rpm|x86_64\.rpm)' ;;
  linux-appimage)       ASSET_GREP='(Linux_x64|amd64)\.AppImage' ;;
  linux-arm64-deb)      ASSET_GREP='(Linux_arm64|arm64)\.deb' ;;
  linux-arm64-rpm)      ASSET_GREP='(Linux_arm64\.rpm|aarch64\.rpm)' ;;
  linux-arm64-appimage) ASSET_GREP='(Linux_arm64|aarch64)\.AppImage' ;;
esac

echo "  ${GRAY}Fetching latest version...${RESET}"
GH_JSON=$(curl -fsSL -H "User-Agent: SinosCLI-Install" "$GITHUB_API" 2>/dev/null || true)
GH_TAG=$(echo "$GH_JSON" | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
LATEST_VER=$(echo "$GH_TAG" | sed 's/^v//')
DOWNLOAD_URL=$(echo "$GH_JSON" | grep -oE "\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]*${ASSET_GREP}\"" | head -1 | sed -E 's/.*"(https[^"]*)"$/\1/')
if [ -z "$DOWNLOAD_URL" ]; then
  LATEST_VER=""
fi

# Empty `version` = the installer for this platform isn't out yet (CI
# probably still running for a just-tagged release). Show an explicit
# "come back later" message and pause so the window doesn't auto-close
# on the user before they read it (some launch flows spawn a fresh
# terminal that closes the moment the script returns).
if [ -z "$LATEST_VER" ]; then
  echo ""
  echo "  ${YELLOW}A new version of Sinos CLI was just released.${RESET}"
  echo "  ${YELLOW}The server is currently redeploying.${RESET}"
  echo "  ${YELLOW}Please try again in about 10 minutes.${RESET}"
  echo ""
  # Read from /dev/tty since stdin is consumed by `curl | sh`. If no tty
  # is attached (CI / redirected), skip the prompt and exit silently.
  if [ -r /dev/tty ]; then
    printf "  ${GRAY}Press Enter to close...${RESET}"
    read _ < /dev/tty
    echo ""
  fi
  exit 0
fi
echo "  ${GREEN}Latest : v$LATEST_VER${RESET}"

# ── macOS ──────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then

  # Detect installed version
  INSTALLED_VER=""
  APP_PATH="/Applications/Sinos CLI.app"
  if [ -d "$APP_PATH" ]; then
    INSTALLED_VER=$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
  fi

  if [ -n "$INSTALLED_VER" ]; then
    echo "  ${GRAY}Installed: v$INSTALLED_VER${RESET}"
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then
      echo ""
      echo "  ${GREEN}Sinos CLI is already up to date (v$INSTALLED_VER).${RESET}"
      echo ""
      exit 0
    fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER  →  v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install...${RESET}"
  fi

  URL="$DOWNLOAD_URL"
  TMP="/tmp/sinos-cli-v${LATEST_VER}.dmg"
  # Always wipe any leftover bytes before downloading. Resume (`-C -`)
  # was REMOVED on purpose: when curl receives a CF 502 / connection
  # reset mid-response (error 56), it has already written the partial
  # 5xx HTML body to $TMP. On the next `--retry-all-errors` attempt,
  # `-C -` would send `Range: bytes=N-` and the server's 206 response
  # would splice valid DMG bytes onto the 5xx-page prefix — the final
  # file hits Content-Length (progress bar shows 100%) but hdiutil
  # rejects it as a corrupt image. Re-downloading from scratch on each
  # retry is the only correctness-preserving option. Same reasoning
  # for the Linux deb / AppImage paths below.
  rm -f "$TMP"

  echo "  ${GRAY}Downloading...${RESET}"
  if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 "$URL" -o "$TMP"; then
    echo ""
    echo "  ${RED}Download failed.${RESET}"
    echo "  ${YELLOW}The macOS installer may still be uploading. Retry in ~5 min.${RESET}"
    echo ""
    exit 1
  fi

  echo "  ${GRAY}Mounting DMG...${RESET}"
  # Grab the /Volumes/... mountpoint directly. `awk '{print $NF}'` breaks
  # when the volume name has spaces (e.g. "Sinos CLI 1.6.4"), since $NF
  # only captures the last whitespace-delimited token.
  #
  # NOTE: do NOT pass -quiet here. -quiet suppresses the very stdout we
  # need to grep for the mountpoint, leaving MOUNT empty and the install
  # falsely reporting "Failed to mount DMG" even on a successful attach.
  # Reported as #18 by @3217333857. The hdiutil verbose output is fine
  # to surface — it's two short lines showing /dev/disk* → /Volumes/...
  MOUNT=$(hdiutil attach "$TMP" -nobrowse | grep -oE '/Volumes/[^	]+' | tail -1)
  if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
    echo "  ${RED}Failed to mount DMG.${RESET}"
    rm -f "$TMP"
    exit 1
  fi
  APP=$(find "$MOUNT" -maxdepth 1 -name "*.app" | head -1)
  if [ -z "$APP" ]; then
    echo "  ${RED}No .app bundle found inside DMG.${RESET}"
    hdiutil detach "$MOUNT" -quiet || true
    rm -f "$TMP"
    exit 1
  fi

  echo "  ${GRAY}Installing to /Applications...${RESET}"
  cp -R "$APP" /Applications/
  hdiutil detach "$MOUNT" -quiet
  rm "$TMP"

  # Strip the com.apple.quarantine xattr that curl-downloaded files
  # inherit. On Apple Silicon macOS 14+, Gatekeeper silently refuses
  # to launch adhoc-signed apps that still carry quarantine — clicking
  # the dock icon does nothing, no error dialog. Removing the xattr
  # tells LaunchServices the user has explicitly opted to trust this
  # binary (equivalent to right-click → Open the first time).
  xattr -dr com.apple.quarantine "/Applications/Sinos CLI.app" 2>/dev/null || true

  echo ""
  echo "  ${GREEN}Done! Sinos CLI v$LATEST_VER installed.${RESET}"
  echo "  ${GRAY}Launch it from /Applications or Spotlight.${RESET}"

# ── Linux ──────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then

  # Detect installed version — prefer package manager
  INSTALLED_VER=""
  if command -v dpkg > /dev/null 2>&1; then
    INSTALLED_VER=$(dpkg -s sinos-cli 2>/dev/null | grep '^Version:' | sed 's/Version: //' || true)
    [ -n "$INSTALLED_VER" ] || INSTALLED_VER=$(dpkg -s coffee-cli 2>/dev/null | grep '^Version:' | sed 's/Version: //' || true)
  fi
  if [ -z "$INSTALLED_VER" ] && command -v rpm > /dev/null 2>&1; then
    INSTALLED_VER=$(rpm -q --queryformat '%{VERSION}' sinos-cli 2>/dev/null || true)
    [ -n "$INSTALLED_VER" ] || INSTALLED_VER=$(rpm -q --queryformat '%{VERSION}' coffee-cli 2>/dev/null || true)
  fi

  if [ -n "$INSTALLED_VER" ]; then
    echo "  ${GRAY}Installed: v$INSTALLED_VER${RESET}"
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then
      echo ""
      echo "  ${GREEN}Sinos CLI is already up to date (v$INSTALLED_VER).${RESET}"
      echo ""
      exit 0
    fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER  →  v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install...${RESET}"
  fi

  # Prefer .deb (Debian/Ubuntu) → .rpm (Fedora/RHEL/openSUSE) → AppImage.
  # The PLATFORM detection above already picked the slug; we just match
  # the install path here. Distro-native packages register the binary
  # in PATH and integrate with the package manager (uninstall via
  # `apt remove` / `dnf remove`); AppImage is portable but the user
  # has to ensure ~/.local/bin is in PATH themselves.
  if command -v dpkg > /dev/null 2>&1; then
    TMP="/tmp/sinos-cli-v${LATEST_VER}.deb"
    rm -f "$TMP"
    echo "  ${GRAY}Downloading .deb package...${RESET}"
    DL_URL="$DOWNLOAD_URL"
    if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 "$DL_URL" -o "$TMP"; then
      echo ""
      echo "  ${RED}Download failed.${RESET}"
      echo "  ${YELLOW}The Linux .deb may still be uploading. Retry in ~5 min.${RESET}"
      echo ""
      exit 1
    fi
    echo "  ${GRAY}Installing (requires sudo)...${RESET}"
    sudo dpkg -i "$TMP"
    rm "$TMP"
    echo ""
    echo "  ${GREEN}Done! Sinos CLI v$LATEST_VER installed.${RESET}"
    exit 0
  fi

  if command -v rpm > /dev/null 2>&1; then
    TMP="/tmp/sinos-cli-v${LATEST_VER}.rpm"
    rm -f "$TMP"
    echo "  ${GRAY}Downloading .rpm package...${RESET}"
    DL_URL="$DOWNLOAD_URL"
    if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 "$DL_URL" -o "$TMP"; then
      echo ""
      echo "  ${RED}Download failed.${RESET}"
      echo "  ${YELLOW}The Linux .rpm may still be uploading. Retry in ~5 min.${RESET}"
      echo ""
      exit 1
    fi
    echo "  ${GRAY}Installing (requires sudo)...${RESET}"
    # Prefer dnf/zypper (resolves dependencies) over raw `rpm -i`. Plain
    # `rpm -i` fails with "Failed dependencies: ..." on newer Fedora /
    # RHEL where webkit2gtk is split into many runtime sub-packages.
    if command -v dnf > /dev/null 2>&1; then
      sudo dnf install -y "$TMP"
    elif command -v zypper > /dev/null 2>&1; then
      sudo zypper --non-interactive install --allow-unsigned-rpm "$TMP"
    elif command -v yum > /dev/null 2>&1; then
      sudo yum install -y "$TMP"
    else
      sudo rpm -i --replacepkgs "$TMP"
    fi
    rm "$TMP"
    echo ""
    echo "  ${GREEN}Done! Sinos CLI v$LATEST_VER installed.${RESET}"
    exit 0
  fi

  # AppImage fallback
  DEST="$HOME/.local/bin/sinos-cli"
  mkdir -p "$HOME/.local/bin"
  # Download to a versioned temp first, then move into place. Writing
  # straight to $DEST would clobber a working install if the download
  # failed partway.
  TMP="/tmp/sinos-cli-v${LATEST_VER}.AppImage"
  rm -f "$TMP"
  echo "  ${GRAY}Downloading AppImage...${RESET}"
  DL_URL="$DOWNLOAD_URL"
  if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 "$DL_URL" -o "$TMP"; then
    echo ""
    echo "  ${RED}Download failed.${RESET}"
    echo "  ${YELLOW}The AppImage may still be uploading. Retry in ~5 min.${RESET}"
    echo ""
    exit 1
  fi
  mv -f "$TMP" "$DEST"
  chmod +x "$DEST"

  echo ""
  echo "  ${GREEN}Done! Sinos CLI v$LATEST_VER installed to $DEST${RESET}"
  echo "  ${GRAY}Make sure ~/.local/bin is in your PATH.${RESET}"

fi

echo ""
