"""Accès en lecture au vrai Paperclip / OmniRoute, et écritures autorisées du banc.

Aucun secret n'est affiché : le jeton board est lu dans un fichier, DATABASE_URL
est lu dans le conteneur et ne quitte jamais la commande ssh.

Écritures possibles (et seulement celles-ci) :
- POST /companies/:id/issues  (tickets de test, enfants de la tâche banc) ;
- POST /issues/:id/comments   (commentaire de suivi des tâches de reprise) ;
- PATCH /agents/:agentTest     (bascule d'adaptateur, voir agent.py).
"""
from __future__ import annotations

import json
import os
import pathlib
import shlex
import subprocess
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'config.json').read_text())

PAPERCLIP_SSH = CONFIG['paperclipSsh']
OMNIROUTE_SSH = CONFIG['omnirouteSsh']


def _token() -> str:
    path = os.environ.get('BANC_TOKEN_FILE') or CONFIG['tokenFile']
    return pathlib.Path(path).read_text().strip()


def api(method: str, path: str, body=None, timeout: int = 90):
    """Appel API Paperclip (jeton board, jamais affiché)."""
    if method != 'GET':
        allowed = (
            path == f"/companies/{CONFIG['companyId']}/issues" and method == 'POST'
        ) or (path.startswith('/issues/') and path.endswith('/comments') and method == 'POST') or (
            path == f"/agents/{CONFIG['agentId']}" and method == 'PATCH'
        )
        if not allowed:
            raise PermissionError(f'écriture non autorisée par le banc : {method} {path}')
    req = urllib.request.Request(
        CONFIG['apiBase'] + path,
        method=method,
        headers={'Authorization': 'Bearer ' + _token(), 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:  # pragma: no cover - réseau
        raise RuntimeError(f'HTTP {e.code} {method} {path}: {e.read()[:300].decode(errors="replace")}') from e


def ssh(host: str, command: str, stdin: str | None = None, timeout: int = 120) -> str:
    r = subprocess.run(['ssh', '-o', 'BatchMode=yes', host, command], input=stdin,
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f'ssh {host} a échoué ({r.returncode}) : {r.stderr[:300]}')
    return r.stdout


def sql(query: str) -> str:
    """Requête PostgreSQL Paperclip en lecture (DATABASE_URL lu et utilisé côté hôte)."""
    cmd = ('DB=$(docker exec paperclip printenv DATABASE_URL); '
           'docker exec -i paperclip psql "$DB" -t -A -v ON_ERROR_STOP=1')
    return ssh(PAPERCLIP_SSH, cmd, stdin=query).strip()


def sql_json(query: str):
    out = sql(query)
    return json.loads(out) if out else None


def sql_lines(query: str):
    return [json.loads(x) for x in sql(query).splitlines() if x.strip()]


def container_read(path: str, max_bytes: int = 2_000_000) -> str | None:
    """Lit un fichier du conteneur paperclip (None s'il n'existe pas)."""
    cmd = f"docker exec paperclip sh -c {shlex.quote(f'test -f {shlex.quote(path)} && head -c {max_bytes} {shlex.quote(path)} || echo __ABSENT__')}"
    out = ssh(PAPERCLIP_SSH, cmd)
    return None if out.strip() == '__ABSENT__' else out


def container_sh(script: str) -> str:
    """Commande de LECTURE dans le conteneur (git log, ls…)."""
    return ssh(PAPERCLIP_SSH, f'docker exec paperclip sh -c {shlex.quote(script)}')


def omniroute_sql(query: str) -> list[list[str]]:
    """Journal d'usage OmniRoute en lecture seule (sqlite -readonly, fichier .sql passé sur stdin)."""
    cmd = f"sqlite3 -readonly -separator '\t' {shlex.quote('file:' + CONFIG['omnirouteDb'] + '?mode=ro')}"
    out = ssh(OMNIROUTE_SSH, cmd, stdin=query)
    return [line.split('\t') for line in out.splitlines() if line.strip()]
