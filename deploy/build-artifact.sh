#!/usr/bin/env bash
# Construit l'artefact AUTONOME de l'adaptateur Paperclip `omniroute_native` (lot 14).
#
# Usage : deploy/build-artifact.sh [dossier-de-sortie]      (défaut : deploy/out)
#   Variable PNPM : commande pnpm (défaut « pnpm » ; ex. PNPM="node /chemin/pnpm.cjs").
#
# Produit, pour le commit courant :
#   omniroute-native-<sha7>.tar.gz          paquet + node_modules de production, sans lien externe
#   omniroute-native-<sha7>.tar.gz.sha256   empreinte de l'archive
#   omniroute-native-<sha7>.manifest.txt    empreinte de chaque fichier (relecture, comparaison)
#
# Contenu de l'archive (racine `omniroute-native/`) : package.json, dist/, ui-parser.cjs,
# README.md, BUILD-INFO.json, node_modules/ (disposition « hoisted » : dossiers réels, pas
# de magasin pnpm). Archive reproductible : ordre trié, dates = date du commit, propriétaire 0,
# gzip sans horodatage. L'empreinte de l'ARCHIVE peut varier d'une version de tar/gzip à
# l'autre ; l'empreinte du CONTENU (CONTENT_SHA256, manifeste trié) est comparable partout.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
read -r -a PNPM_CMD <<< "${PNPM:-pnpm}"
PKG_NAME="@agence/omniroute-native"
PKG_DIR="packages/adapters/omniroute-native"
OUT="${1:-$ROOT/deploy/out}"
SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:7}"
EPOCH="$(git log -1 --format=%ct HEAD)"
DIRTY="$(git status --porcelain -- "$PKG_DIR" pnpm-lock.yaml package.json | wc -l | tr -d ' ')"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/omniroute-native-artifact.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/omniroute-native"

echo "== construction de dist/ ($SHORT)"
"${PNPM_CMD[@]}" --filter "$PKG_NAME" build >/dev/null

echo "== pnpm deploy --prod (node_modules « hoisted », sans lien vers le dépôt)"
"${PNPM_CMD[@]}" --filter "$PKG_NAME" deploy --prod --config.node-linker=hoisted "$DEST" >/dev/null
# Métadonnées pnpm : non nécessaires à l'exécution, et non reproductibles (horodatage, chemins).
rm -rf "$DEST/node_modules/.modules.yaml" "$DEST/node_modules/.pnpm" \
       "$DEST/node_modules/.pnpm-workspace-state.json" "$DEST/node_modules/.package-lock.json"
[ -f "$DEST/dist/index.js" ] || { echo "dist/index.js absent de l'artefact" >&2; exit 1; }

DIRTY_JSON=false; [ "$DIRTY" != "0" ] && DIRTY_JSON=true
VERSION="$(node -p "require('$DEST/package.json').version")"
cat > "$DEST/BUILD-INFO.json" <<EOF
{
  "package": "$PKG_NAME",
  "type": "omniroute_native",
  "version": "$VERSION",
  "gitCommit": "$SHA",
  "gitCommitTime": $EPOCH,
  "dirty": $DIRTY_JSON,
  "layout": "pnpm deploy --prod --config.node-linker=hoisted"
}
EOF

echo "== porte de qualité (liens, résolutions, plugin-loader, lockfile)"
node "$ROOT/deploy/verify-artifact.mjs" --lock "$ROOT/pnpm-lock.yaml" "$DEST"

echo "== archive reproductible"
ARCHIVE="$OUT/omniroute-native-$SHORT.tar.gz"
(cd "$DEST" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$OUT/omniroute-native-$SHORT.manifest.txt"
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' --format=gnu -C "$STAGE" -cf - omniroute-native \
  | gzip -n -9 > "$ARCHIVE"
(cd "$OUT" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")

echo "ARTIFACT $ARCHIVE"
echo "SHA256 $(cut -d' ' -f1 "$ARCHIVE.sha256")"
# Empreinte du CONTENU (indépendante des versions de tar/gzip) : c'est elle qu'on compare
# entre la CI et le poste qui déploie ; omniroute_native_deploy.py la recalcule depuis l'archive.
echo "CONTENT_SHA256 $(sha256sum < "$OUT/omniroute-native-$SHORT.manifest.txt" | cut -d' ' -f1)"
echo "FILES $(wc -l < "$OUT/omniroute-native-$SHORT.manifest.txt") DIRTY $DIRTY_JSON COMMIT $SHA"
