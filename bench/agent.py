"""Bascule de l'agent de test entre omniroute_native et claude_local, avec sauvegarde et preuve de restauration.

  python3 bench/agent.py sauver   --fichier <sauvegarde.json>
  python3 bench/agent.py basculer --vers claude_local --fichier <sauvegarde.json>
  python3 bench/agent.py restaurer --fichier <sauvegarde.json>     # remet adapter_type + adapter_config (+ runtime_config)
  python3 bench/agent.py diff      --fichier <sauvegarde.json>     # « DIFF VIDE » si identique

Garde-fou : avant toute bascule, la configuration (adapter_type + adapter_config + runtime_config) doit être
celle de la sauvegarde ou celle de NOTRE dernier PATCH (empreinte dans un fichier d'état à côté de la sauvegarde) ;
sinon quelqu'un d'autre a modifié l'agent → arrêt. `updated_at` ne convient pas : il bouge à chaque fin de run.
Côté claude_local : même modèle, aucune clé liée (la clé du conteneur est héritée par le CLI).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from banc import infra  # noqa: E402

CFG = infra.CONFIG
OMNI = os.environ.get('OMNIROUTE_BASE_URL', 'http://localhost:20128')


def snapshot() -> dict:
    return infra.sql_json(
        "select json_build_object('id',id,'adapter_type',adapter_type,'adapter_config',adapter_config,"
        f"'runtime_config',runtime_config,'updated_at',updated_at) from agents where id='{CFG['agentId']}';")


def claude_local_config(model: str = 'AC-pro-coding') -> dict:
    plain = lambda v: {'type': 'plain', 'value': v}  # noqa: E731
    return {'model': model, 'timeoutSec': 3600, 'dangerouslySkipPermissions': True,
            'env': {'ANTHROPIC_BASE_URL': plain(OMNI), 'ANTHROPIC_MODEL': plain(model),
                    'ANTHROPIC_DEFAULT_OPUS_MODEL': plain(model), 'ANTHROPIC_DEFAULT_SONNET_MODEL': plain(model),
                    'ANTHROPIC_DEFAULT_HAIKU_MODEL': plain(model)}}


def diff(saved: dict, cur: dict) -> dict:
    return {k: {'sauvegarde': saved[k], 'actuel': cur[k]} for k in ('adapter_type', 'adapter_config', 'runtime_config')
            if json.dumps(saved[k], sort_keys=True) != json.dumps(cur[k], sort_keys=True)}


def state_path(f: pathlib.Path) -> pathlib.Path:
    return f.with_name(f.stem + '-etat.json')


def fingerprint(st: dict) -> str:
    doc = json.dumps([st['adapter_type'], st['adapter_config'], st['runtime_config']], sort_keys=True)
    return hashlib.sha256(doc.encode()).hexdigest()[:16]


def guard(f: pathlib.Path, saved: dict, cur: dict) -> None:
    """La configuration actuelle doit être la sauvegarde ou NOTRE dernier PATCH.

    `updated_at` bouge à chaque fin de run (= last_heartbeat_at) : on compare donc le contenu
    (adapter_type + adapter_config + runtime_config), pas l'horodatage.
    """
    sp = state_path(f)
    ours = json.loads(sp.read_text()).get('empreinte_dernier_patch') if sp.exists() else None
    if fingerprint(cur) not in (fingerprint(saved), ours):
        raise SystemExit(f"BLOQUANT : la configuration de l'agent a été modifiée par quelqu'un d'autre "
                         f"(empreinte {fingerprint(cur)}, attendu {fingerprint(saved)} ou {ours}). Arrêt sans écriture.")


def patch(f: pathlib.Path, body: dict) -> dict:
    infra.api('PATCH', f"/agents/{CFG['agentId']}", body)
    cur = snapshot()
    state_path(f).write_text(json.dumps({'empreinte_dernier_patch': fingerprint(cur), 'updated_at': cur['updated_at'],
                                         'adapter_type': cur['adapter_type']}, indent=1))
    return cur


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['sauver', 'basculer', 'restaurer', 'diff'])
    ap.add_argument('--fichier', required=True)
    ap.add_argument('--vers', choices=['claude_local', 'omniroute_native'])
    a = ap.parse_args()
    f = pathlib.Path(a.fichier)
    if a.cmd == 'sauver':
        if f.exists():
            raise SystemExit(f'{f} existe déjà : on ne réécrit pas une sauvegarde.')
        f.write_text(json.dumps(snapshot(), indent=1, ensure_ascii=False)); print('sauvegardé', f); return
    saved = json.loads(f.read_text())
    cur = snapshot()
    if a.cmd == 'diff':
        d = diff(saved, cur)
        print('DIFF VIDE' if not d else json.dumps(d, indent=1, ensure_ascii=False)); return
    guard(f, saved, cur)
    if a.cmd == 'basculer' and a.vers == 'claude_local':
        cur = patch(f, {'adapterType': 'claude_local', 'adapterConfig': claude_local_config(), 'replaceAdapterConfig': True})
    else:  # restaurer, ou basculer vers omniroute_native = configuration sauvegardée telle quelle
        body = {'adapterType': saved['adapter_type'], 'adapterConfig': saved['adapter_config'], 'replaceAdapterConfig': True}
        if json.dumps(saved['runtime_config'], sort_keys=True) != json.dumps(cur['runtime_config'], sort_keys=True):
            body['runtimeConfig'] = saved['runtime_config']
        cur = patch(f, body)
        d = diff(saved, cur)
        print('DIFF VIDE' if not d else 'DIFF NON VIDE : ' + json.dumps(d, ensure_ascii=False))
    print(json.dumps({'adapter_type': cur['adapter_type'], 'updated_at': cur['updated_at'],
                      'model': cur['adapter_config'].get('model'), 'env': sorted((cur['adapter_config'].get('env') or {}).keys())},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
