#!/bin/sh
# install.sh — set up Lavish on this machine: the pinned lavish-axi with the local patches, the
# lavish-poll / lavish-meta / review-checklist CLIs, the skills, and the home page (launchd on macOS).
#
#   git clone https://github.com/marcusc8/lavish.git ~/.claude/skills/lavish
#   sh ~/.claude/skills/lavish/tools/install.sh
#
# Re-runnable: every step is idempotent. Overrides (environment variables):
#   LAVISH_BIN          where the CLI symlinks go            (default ~/.local/bin; must be on PATH)
#   CLAUDE_CONFIG_DIR   Claude Code's config folder           (default ~/.claude; skills go in <it>/skills)
#   LAVISH_HOME_PORT    the home page's port                  (default 4388)
#   LAVISH_NO_HOME=1    skip the launchd step (servers, CI, Linux)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${LAVISH_BIN:-$HOME/.local/bin}"
SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
PORT="${LAVISH_HOME_PORT:-4388}"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found; install Node 22 or newer first"; exit 1; }
major="$("$NODE" -p 'Number(process.versions.node.split(".")[0])')"
[ "$major" -ge 22 ] || { echo "node $("$NODE" -v) is too old; need 22 or newer"; exit 1; }

PIN="$(cat "$ROOT/tools/pinned-version.txt")"
have="$("$NODE" -p "try{require('$(npm root -g)/lavish-axi/package.json').version}catch{''}")"
if [ "$have" = "$PIN" ]; then
  echo "1/5 lavish-axi@$PIN already installed"
else
  echo "1/5 installing lavish-axi@$PIN globally (have: ${have:-none})"
  npm i -g "lavish-axi@$PIN" >/dev/null
fi
echo "2/5 applying the local patches (comments rail, saved chats, private notes, versions)"
"$NODE" "$ROOT/tools/patch-lavish.mjs"

echo "3/5 CLIs in $BIN"
mkdir -p "$BIN"
chmod +x "$ROOT"/tools/*.mjs "$ROOT/extras/review-changes/tools/review-checklist.mjs"
ln -sfn "$ROOT/tools/lavish-poll.mjs" "$BIN/lavish-poll"
ln -sfn "$ROOT/tools/lavish-meta.mjs" "$BIN/lavish-meta"
ln -sfn "$ROOT/extras/review-changes/tools/review-checklist.mjs" "$BIN/review-checklist"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "   NOTE: $BIN is not on your PATH; add it" ;; esac
command -v lavish-axi >/dev/null 2>&1 || echo "   NOTE: lavish-axi is in $(npm prefix -g)/bin; add that to your PATH"

echo "4/5 skills in $SKILLS"
mkdir -p "$SKILLS"
[ -e "$SKILLS/lavish" ] || ln -s "$ROOT" "$SKILLS/lavish"
[ -e "$SKILLS/review-changes" ] || ln -s "$ROOT/extras/review-changes" "$SKILLS/review-changes"
echo "   verify-changes is per project: copy extras/verify-changes into <project>/.claude/skills/ (see README)"

echo "5/5 home page on http://127.0.0.1:$PORT"
if [ "${LAVISH_NO_HOME:-}" = 1 ]; then
  echo "   skipped (LAVISH_NO_HOME=1); run:  node $ROOT/tools/lavish-home.mjs"
elif [ "$(uname)" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/com.marcus.lavish-home.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.lavish-axi"
  TMUX="$(command -v tmux || echo /usr/local/bin/tmux)"
  CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
  CODEX="$(command -v codex || echo "$HOME/.local/bin/codex")"
  sed -e "s|__NODE__|$NODE|g" -e "s|__TOOLS__|$ROOT/tools|g" -e "s|__HOME__|$HOME|g" -e "s|__PORT__|$PORT|g" \
      -e "s|__TMUX__|$TMUX|g" -e "s|__CLAUDE__|$CLAUDE|g" -e "s|__CODEX__|$CODEX|g" \
      -e "s|__PATH__|$BIN:$(dirname "$NODE"):$(dirname "$TMUX"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|g" \
      "$ROOT/tools/lavish-home.plist.template" > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  sleep 2
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then echo "   home page answers"; else echo "   not answering yet; see ~/.lavish-axi/home.log"; fi
  [ -x "$TMUX" ] || echo "   NOTE: tmux not found; Resume / New session on the home page need it (brew install tmux)"
else
  echo "   no launchd here; run  node $ROOT/tools/lavish-home.mjs  under your service manager"
fi
echo "done. Tests: node --test $ROOT/tools/test/*.test.mjs $ROOT/extras/review-changes/tools/test/*.test.mjs"
