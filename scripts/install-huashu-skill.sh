#!/bin/bash
# install-huashu-skill.sh — Install huashu-design skill into ~/.claude/skills/
#
# huashu-design (https://github.com/alchaincyf/huashu-design) is a separately
# licensed AI-native design skill by alchaincyf (花生). LICENSE: Personal Use Only.
#
# This script does NOT bundle huashu-design with coreline-agent. It only sets up
# a separate symlink (preferred) or git clone in your personal ~/.claude/skills/
# directory so you can invoke it from external agents (Claude Code, Cursor, etc.).
#
# For commercial deployment, contact @AlchainHust before using huashu-design.

set -e

TARGET="${HOME}/.claude/skills/huashu-design"
SOURCE="${HUASHU_DESIGN_PATH:-${HOME}/projects/claude-code/huashu-design}"
GIT_URL="https://github.com/alchaincyf/huashu-design.git"

echo "huashu-design skill installer"
echo "============================="
echo ""

# Already installed?
if [ -e "$TARGET" ]; then
  echo "✓ Already installed at $TARGET"
  if [ -L "$TARGET" ]; then
    echo "  (symlink → $(readlink "$TARGET"))"
  fi
  echo ""
  echo "To reinstall, remove the existing entry first:"
  echo "  rm -rf '$TARGET'"
  exit 0
fi

# Ensure parent directory
mkdir -p "${HOME}/.claude/skills"

# Strategy 1: symlink to local clone if HUASHU_DESIGN_PATH or default exists
if [ -d "$SOURCE" ] && [ -f "$SOURCE/SKILL.md" ]; then
  echo "→ Found local clone at $SOURCE"
  ln -s "$SOURCE" "$TARGET"
  echo "✓ Symlinked → $TARGET"
else
  # Strategy 2: fresh git clone
  echo "→ No local clone found at $SOURCE"
  echo "→ Cloning from $GIT_URL ..."
  git clone --depth 1 "$GIT_URL" "$TARGET"
  echo "✓ Cloned into $TARGET"
fi

echo ""
echo "Setup complete."
echo ""
echo "Verification:"
echo "  ls -la '$TARGET/SKILL.md'"
echo ""
echo "Usage (from external agents like Claude Code or Cursor):"
echo "  > 'huashu-design 스킬을 사용해서 발표 슬라이드 만들어줘'"
echo ""
echo "License reminder: huashu-design is Personal Use Only."
echo "For commercial deployment, contact @AlchainHust."
