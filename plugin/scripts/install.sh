#!/bin/sh
# Builds the muse-ax Swift CLI and installs it to ~/.claude-bot-bridge/bin/muse-ax.
# Safe to re-run: swift build is incremental and the binary is only replaced when it changed.
# Needs macOS and the Xcode Command Line Tools (xcode-select --install). Node 20+ is needed to run the MCP server.
#
# Options:
#   --with-canary     also install the hourly Muse-version canary (a launchd agent running `muse-ax canary`)
#   --remove-canary   uninstall that launchd agent and exit (nothing is built)
#   --uninstall       remove ~/.claude-bot-bridge (or CBB_HOME; bin, build, rules cache, state, send journal, logs) and the
#                     canary launchd agent, then print the manual steps that remain. Touches nothing else. It refuses a folder
#                     that does not carry one of our markers (.cbb-home, .setup-done or bin/muse-ax).
# CBB_HOME moves the whole bridge folder (default ~/.claude-bot-bridge): the build, the binary, the markers and the canary.
# The MCP server runs this script itself, without options, when it cannot install a verified prebuilt binary, but
# only after this installer has run once (it leaves ~/.claude-bot-bridge/.setup-done) or CBB_ALLOW_LOCAL_BUILD=1 is set.
set -eu

fail() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

with_canary=0; remove_canary=0; uninstall=0
for arg in "$@"; do
  case "$arg" in
    --with-canary) with_canary=1 ;;
    --remove-canary) remove_canary=1 ;;
    --uninstall) uninstall=1 ;;
    *) fail "unknown option: $arg (use --with-canary, --remove-canary or --uninstall)" ;;
  esac
done
# One place for the bridge folder: install, canary and uninstall all use it.
cbb_home="${CBB_HOME:-$HOME/.claude-bot-bridge}"
canary_label="com.qualixar.cbb.canary"
canary_plist="$HOME/Library/LaunchAgents/$canary_label.plist"

remove_canary_agent() {
  launchctl bootout "gui/$(id -u)/$canary_label" >/dev/null 2>&1 || true
  if [ -f "$canary_plist" ]; then rm -f "$canary_plist"; echo "Removed $canary_plist"; else echo "Canary was not installed."; fi
}

install_canary_agent() { # <plist template> <muse-ax binary>
  [ -x "$2" ] || fail "muse-ax is not installed at $2"
  case "$cbb_home" in *'|'*|*'&'*) fail "the bridge folder path contains a character that cannot be put in the plist" ;; esac
  mkdir -p "$cbb_home/logs" "$HOME/Library/LaunchAgents"
  sed "s|__CBB_HOME__|$cbb_home|g" "$1" > "$canary_plist.tmp" && mv -f "$canary_plist.tmp" "$canary_plist"
  plutil -lint "$canary_plist" >/dev/null || fail "generated plist is invalid: $canary_plist"
  launchctl bootout "gui/$(id -u)/$canary_label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$canary_plist" || fail "launchctl bootstrap failed for $canary_plist"
  echo "Canary installed: runs hourly and at login. Logs: $cbb_home/logs/"
  echo "Grant $2 Accessibility permission (System Settings > Privacy & Security > Accessibility) so it can read Muse;"
  echo "a rebuilt binary has a new signature, so grant it again after rebuilding."
}

# True when <dir> carries a marker that only this installer or the updater leaves: .cbb-home (written by every install),
# .setup-done (the consent marker of older installs) or an installed bin/muse-ax.
has_cbb_marker() { [ -f "$1/.cbb-home" ] || [ -f "$1/.setup-done" ] || [ -f "$1/bin/muse-ax" ]; }

# The bridge home to delete: CBB_HOME or ~/.claude-bot-bridge, but only when it is an absolute path with no "." / ".."
# parts whose REAL location (symlinks resolved) is strictly inside the real $HOME AND that proves it is ours with a marker
# (has_cbb_marker). Without CBB_HOME the folder must also be called .claude-bot-bridge; an explicit CBB_HOME may have any name
# but still needs the marker. Prints the real path, or nothing when the directory does not exist. Anything else is refused
# before a single file is touched.
bridge_home_to_remove() {
  [ -n "${HOME:-}" ] || fail "refusing to uninstall: HOME is empty"
  raw="$cbb_home"
  case "$raw" in /*) ;; *) fail "refusing to uninstall: CBB_HOME must be an absolute path (got: $raw)" ;; esac
  case "/$raw/" in */../*|*/./*) fail "refusing to uninstall: CBB_HOME must not contain . or .. parts (got: $raw)" ;; esac
  home_real=$(cd "$HOME" 2>/dev/null && pwd -P) || fail "refusing to uninstall: HOME is not a directory"
  if [ ! -e "$raw" ] && [ ! -L "$raw" ]; then return 0; fi
  [ -d "$raw" ] || fail "refusing to uninstall: $raw is not a directory"
  real=$(cd "$raw" && pwd -P) || fail "refusing to uninstall: cannot resolve $raw"
  case "$real" in
    "$home_real"/?*) ;;
    *) fail "refusing to uninstall: $real is not inside $home_real (CBB_HOME must be a folder under your home directory)" ;;
  esac
  has_cbb_marker "$real" || fail "refusing to uninstall: $real has none of our markers (.cbb-home, .setup-done, bin/muse-ax), so it does not look like a Claude Bot Bridge folder. Nothing was deleted."
  if [ -z "${CBB_HOME:-}" ] && [ "$(basename "$real")" != ".claude-bot-bridge" ]; then
    fail "refusing to uninstall: $real is not called .claude-bot-bridge (set CBB_HOME to it explicitly if it really is the bridge folder). Nothing was deleted."
  fi
  printf '%s\n' "$real"
}

uninstall_bridge() {
  target=$(bridge_home_to_remove)
  remove_canary_agent
  if [ -n "$target" ]; then
    rm -rf -- "$target"
    echo "Removed $target (muse-ax, build output, rules cache, state, send journal, logs)."
  else
    echo "Nothing to remove: no bridge folder at $cbb_home."
  fi
  echo
  echo "Two steps are left for you:"
  echo "  1. System Settings > Privacy & Security > Accessibility: remove the entry for muse-ax (and for the terminal or app"
  echo "     you granted for Claude Code, if you no longer need it)."
  echo "  2. Remove the plugin: claude plugin uninstall bot-bridge@claude-bot-bridge"
}

if [ "$uninstall" = 1 ]; then uninstall_bridge; exit 0; fi

[ "$(uname -s)" = "Darwin" ] || fail "macOS only (muse-ax uses the macOS Accessibility API)."

if [ "$remove_canary" = 1 ]; then remove_canary_agent; exit 0; fi

command -v swift >/dev/null 2>&1 || fail "swift not found. Install the Command Line Tools with: xcode-select --install"
xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools are not installed. Run: xcode-select --install"

if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 20 ] || fail "Node $node_major found, Node 20 or newer is required for the MCP server."
else
  fail "node not found. Install Node 20 or newer (the MCP server runs on it)."
fi

here=$(cd "$(dirname "$0")" && pwd)
src="$here/../bridge/muse"
[ -f "$src/Package.swift" ] || fail "Swift package not found at $src"

home_dir="$cbb_home"
bin_dir="$home_dir/bin"
scratch="$home_dir/build"
mkdir -p "$bin_dir"

echo "Building muse-ax (release). The first build takes a minute or two..."
# --scratch-path keeps build output out of the plugin directory, which Claude Code replaces on update.
swift build -c release --package-path "$src" --scratch-path "$scratch" >&2 || fail "swift build failed. See the output above."

built="$scratch/release/muse-ax"
[ -x "$built" ] || fail "build finished but $built is missing."

target="$bin_dir/muse-ax"
if [ -f "$target" ] && cmp -s "$built" "$target"; then
  echo "muse-ax is up to date: $target"
else
  # Keep the binary being replaced as muse-ax.prev, for rollback (see the README).
  if [ -f "$target" ]; then cp -p "$target" "$target.prev"; fi
  tmp="$target.new.$$"
  cp "$built" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$target"
  echo "Installed: $target"
fi

# Identity marker: proves to --uninstall that this folder is ours. Written on every install, automatic builds included.
date -u +%Y-%m-%dT%H:%M:%SZ > "$home_dir/.cbb-home"

# Consent marker: the MCP server may rebuild the helper itself only after the user has run this installer.
# (The MCP server sets CBB_NO_SETUP_MARKER=1 when it runs this script itself, so an automatic build never grants consent.)
[ "${CBB_NO_SETUP_MARKER:-}" = 1 ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$home_dir/.setup-done"

if [ "$with_canary" = 1 ]; then install_canary_agent "$here/com.qualixar.cbb.canary.plist" "$target"; fi

echo
echo "Next: grant Accessibility permission to the app that runs Claude Code (Terminal, iTerm, or Claude)"
echo "in System Settings > Privacy & Security > Accessibility, then open Muse and run:"
echo "  $target status"
