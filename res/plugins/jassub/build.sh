#!/bin/sh
# Rebuilds bundled JASSUB files in this folder.
# Usage: ./build.sh [jassub version]
set -e
cd "$(dirname "$0")"
VERSION="${1:-2.5.37}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npm install --prefix "$TMP" --no-save --silent "jassub@$VERSION" esbuild@0.25
DIST="$TMP/node_modules/jassub/dist"
ESBUILD="$TMP/node_modules/.bin/esbuild"

# keep dist layout, so relative urls in jassub.js resolve without options
mkdir -p worker wasm licenses
"$ESBUILD" "$DIST/jassub.js" --bundle --format=esm --minify --target=es2020 \
	--log-level=warning --outfile=jassub.js
"$ESBUILD" "$DIST/worker/worker.js" --bundle --format=esm --minify --target=es2020 \
	--log-level=warning --outfile=worker/worker.js
cp "$DIST"/wasm/*.js "$DIST"/wasm/*.wasm wasm/
cp "$DIST/default.woff2" .

for pkg in jassub abslink lfa-ponyfill rvfc-polyfill throughput; do
	license="$(find "$TMP/node_modules/$pkg" -maxdepth 1 -iname 'licen[cs]e*' | head -n 1)"
	if [ -n "$license" ]; then
		cp "$license" "licenses/$pkg.txt"
	else
		node -p "'License: ' + require('$TMP/node_modules/$pkg/package.json').license" > "licenses/$pkg.txt"
	fi
done
echo "Built jassub@$VERSION"
