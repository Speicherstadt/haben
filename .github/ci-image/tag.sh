#!/usr/bin/env bash
# Gibt Versionen und Tag des CI-Images als key=value aus, Tag: <Playwright-Version>-<12 Zeichen SHA-256 über
# Containerfile und Bun-Version>. ci-image.yml baut unter diesem Tag, ci.yml zieht ihn; beide rechnen ihn gleich.
set -euo pipefail
cd "$(dirname "$0")/../.."
playwright="$(sed -nE 's/.*"@playwright\/test": *"([^"]+)".*/\1/p' apps/web/package.json)"
bun="$(sed -nE 's/.*"packageManager": *"bun@([^"]+)".*/\1/p' package.json)"
hash="$( { cat .github/ci-image/Containerfile; echo "bun=$bun"; } | sha256sum | cut -c1-12)"
echo "playwright=$playwright"
echo "bun=$bun"
echo "tag=$playwright-$hash"
