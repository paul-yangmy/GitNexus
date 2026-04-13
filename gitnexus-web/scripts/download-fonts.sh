#!/usr/bin/env bash
# Download Fira Sans + Fira Code woff2 files from npmmirror (CDN friendly for CN intranet).
# Run once before first deployment: bash scripts/download-fonts.sh
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/public/fonts"
mkdir -p "$DEST"

BASE="https://cdn.npmmirror.com/packages"

declare -A FILES=(
  # Fira Sans
  ["fira-sans-latin-300-normal.woff2"]="@fontsource/fira-sans/3.4.1/files/fira-sans-latin-300-normal.woff2"
  ["fira-sans-latin-400-normal.woff2"]="@fontsource/fira-sans/3.4.1/files/fira-sans-latin-400-normal.woff2"
  ["fira-sans-latin-500-normal.woff2"]="@fontsource/fira-sans/3.4.1/files/fira-sans-latin-500-normal.woff2"
  ["fira-sans-latin-600-normal.woff2"]="@fontsource/fira-sans/3.4.1/files/fira-sans-latin-600-normal.woff2"
  ["fira-sans-latin-700-normal.woff2"]="@fontsource/fira-sans/3.4.1/files/fira-sans-latin-700-normal.woff2"
  # Fira Code
  ["fira-code-latin-400-normal.woff2"]="@fontsource/fira-code/5.2.5/files/fira-code-latin-400-normal.woff2"
  ["fira-code-latin-500-normal.woff2"]="@fontsource/fira-code/5.2.5/files/fira-code-latin-500-normal.woff2"
  ["fira-code-latin-600-normal.woff2"]="@fontsource/fira-code/5.2.5/files/fira-code-latin-600-normal.woff2"
  ["fira-code-latin-700-normal.woff2"]="@fontsource/fira-code/5.2.5/files/fira-code-latin-700-normal.woff2"
)

for FILENAME in "${!FILES[@]}"; do
  DEST_FILE="$DEST/$FILENAME"
  if [[ -f "$DEST_FILE" ]]; then
    echo "  skip  $FILENAME (already exists)"
    continue
  fi
  PKG_PATH="${FILES[$FILENAME]}"
  # npmmirror CDN path format: /packages/<scope>/<name>/<version>/files/<file>
  PKG_PATH_ENC="${PKG_PATH//@/%40}"
  URL="$BASE/${PKG_PATH_ENC}"
  echo "  fetch $FILENAME"
  curl -fsSL "$URL" -o "$DEST_FILE" || {
    echo "  ERROR: failed to download $FILENAME"
    exit 1
  }
done

echo "Done — fonts written to $DEST"
