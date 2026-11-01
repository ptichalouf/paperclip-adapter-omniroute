#!/usr/bin/env bash
set -euo pipefail

# Contrôle anti-fuite pour le dépôt public paperclip-adapter-omniroute
# Empêche la publication d'adresses IP privées, chemins internes, jetons et identifiants locaux.

echo "==> Vérification anti-fuite de données internes..."

FAIL=0

check_pattern() {
  local pattern="$1"
  local desc="$2"
  local exclude_pathspec="${3:-}"

  echo "Contrôle : $desc ($pattern)..."
  local matches
  if [ -n "$exclude_pathspec" ]; then
    matches=$(git grep -E -n "$pattern" -- . "$exclude_pathspec" || true)
  else
    matches=$(git grep -E -n "$pattern" -- . || true)
  fi

  if [ -n "$matches" ]; then
    echo "❌ Résidu interne détecté pour : $desc"
    echo "$matches"
    FAIL=1
  else
    echo "  ✓ OK"
  fi
}

# 1. IP privées LAN (192.168.*)
check_pattern '192\.168\.' "Adresses IP LAN privées"

# 2. Chemins internes /opt/data
check_pattern '/opt/data' "Chemins internes /opt/data"

# 3. Noms de domaine et hôtes internes
check_pattern 'ptichalouf\.xyz' "Domaine privé ptichalouf.xyz"

# 4. Emplacement de jetons d'instance Paperclip
check_pattern 'board-token' "Jetons ou noms board-token internes"

# 5. Chemins d'array ou montage /mnt/ (autorisé uniquement comme fixture de test dans deploy/tests/test_deploy.py)
check_pattern '/mnt/' "Chemins de montage /mnt/" ":!deploy/tests/test_deploy.py"

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "❌ ÉCHEC DU CONTRÔLE ANTI-FUITE : des résidus internes ont été détectés."
  exit 1
fi

echo ""
echo "✅ CONTRÔLE ANTI-FUITE RÉUSSI : aucun résidu interne détecté."
exit 0
