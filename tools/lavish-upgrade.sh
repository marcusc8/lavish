#!/bin/zsh
# lavish-upgrade.sh — move the pinned lavish-axi install to a new version and re-apply the
# local patches. If the patches no longer fit, roll back to the previous version so Lavish
# keeps working with the features you rely on.
#
#   ~/.claude/skills/lavish/tools/lavish-upgrade.sh            # latest
#   ~/.claude/skills/lavish/tools/lavish-upgrade.sh 0.1.70     # a specific version
set -u
TOOLS="$(cd "$(dirname "$0")" && pwd)"
PKG="$(npm root -g)/lavish-axi"
PIN="$TOOLS/pinned-version.txt"
want="${1:-latest}"
prev="$(node -p "require('$PKG/package.json').version" 2>/dev/null || echo "")"
echo "current: ${prev:-none}  →  requested: $want"

npm i -g "lavish-axi@$want" >/dev/null 2>&1 || { echo "npm install failed"; exit 1; }
new="$(node -p "require('$PKG/package.json').version")"
echo "installed: $new"

if node "$TOOLS/patch-lavish.mjs"; then
  echo "$new" > "$PIN"
  lavish-axi stop >/dev/null 2>&1 || true
  echo "OK: lavish-axi $new patched and pinned. The server was stopped; the next lavish-axi call starts the new build."
  exit 0
fi

echo
echo "PATCH FAILED on $new. Rolling back to ${prev:-the pinned version}."
back="${prev:-$(cat "$PIN" 2>/dev/null)}"
[ -n "$back" ] || { echo "no previous version known; leaving $new unpatched"; exit 1; }
npm i -g "lavish-axi@$back" >/dev/null 2>&1 && node "$TOOLS/patch-lavish.mjs" && lavish-axi stop >/dev/null 2>&1
echo "Rolled back to $back (patched). Upstream changed the code the patch anchors on;"
echo "compare $PKG/dist against the anchors in patch-lavish.mjs and update them, then re-run."
exit 1
