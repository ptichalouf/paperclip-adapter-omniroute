"""Lanceur du banc : un ticket par tâche, un run à la fois, mesure en lecture seule.

Usage (depuis la racine du dépôt) :
  python3 bench/lancer.py run --adaptateur omniroute_native --sortie <dossier> [--taches T01,T05]
  python3 bench/lancer.py rapport --sortie <dossier>          # tableau Markdown comparatif

L'agent de test doit déjà être sur l'adaptateur demandé (voir bench/agent.py) ; le lanceur
refuse de démarrer sinon, et s'arrête si la configuration de l'agent change pendant le banc.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from banc import criteres, infra, mesure, rapport  # noqa: E402

CFG = infra.CONFIG
TACHES = pathlib.Path(__file__).resolve().parent / 'taches'
SHORT = {'omniroute_native': 'on', 'claude_local': 'cl'}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def agent_state() -> dict:
    """Type d'adaptateur + empreinte de la configuration.

    `updated_at` ne sert pas de témoin : Paperclip le met à jour à chaque fin de run
    (= last_heartbeat_at, mesuré le 31/10). L'empreinte porte sur adapter_type,
    adapter_config et runtime_config, seuls champs que le banc fait varier.
    """
    st = infra.sql_json(
        "select json_build_object('adapter_type',adapter_type,'adapter_config',adapter_config,"
        f"'runtime_config',runtime_config,'updated_at',updated_at) from agents where id='{CFG['agentId']}';")
    st['empreinte'] = config_fingerprint(st)
    return st


def config_fingerprint(st: dict) -> str:
    import hashlib
    doc = json.dumps([st['adapter_type'], st['adapter_config'], st['runtime_config']], sort_keys=True)
    return hashlib.sha256(doc.encode()).hexdigest()[:16]


def load_tasks(ids: list[str] | None) -> list[dict]:
    tasks = [json.loads(p.read_text()) for p in sorted(TACHES.glob('T*.json'))]
    return [t for t in tasks if not ids or t['id'] in ids]


def runs_since(iid: str, since: str) -> list[dict]:
    return infra.sql_lines(
        "select json_build_object('id',id,'status',status,'finished',finished_at is not null,'created_at',created_at) "
        f"from heartbeat_runs where (issue_id='{iid}' or context_snapshot->>'issueId'='{iid}') "
        f"and created_at >= '{since}' order by created_at;")


def wait_wave(iid: str, since: str) -> dict:
    t0 = time.time(); quiet_since = None; runs = []
    while time.time() - t0 < CFG['waveTimeoutSec']:
        time.sleep(10)
        runs = runs_since(iid, since)
        if runs and all(r['finished'] for r in runs):
            quiet_since = quiet_since or time.time()
            if time.time() - quiet_since >= CFG['quietSec']:
                return {'runs': runs, 'timeout': False, 'attente_s': round(time.time() - t0)}
        else:
            quiet_since = None
    return {'runs': runs, 'timeout': True, 'attente_s': round(time.time() - t0)}


def run_details(rid: str, adapter: str) -> dict:
    row = infra.sql_json(f"""select json_build_object('id',id,'status',status,'error_code',error_code,
      'started_at',started_at,'finished_at',finished_at,
      'dur',extract(epoch from (finished_at-started_at)),'usage',usage_json,
      'turns',coalesce(result_json->>'turns',result_json->>'num_turns',result_json->'result'->>'num_turns'),
      'final_disposition',result_json->'finalResponse'->>'disposition',
      'final_text',left(coalesce(result_json->'finalResponse'->>'text',result_json->>'summary',result_json->>'result',''),600),
      'comment_status',issue_comment_status,'log_ref',log_ref) from heartbeat_runs where id='{rid}';""")
    row['adapter'] = adapter
    ref = row.get('log_ref')
    log = infra.container_read(f"{CFG['runLogRoot']}/{ref}", max_bytes=20_000_000) if ref else None
    row['log'] = mesure.analyse_log(log or '')
    if row['turns'] is None and row['log'].get('num_turns') is not None:
        row['turns'] = row['log']['num_turns']
    row['tokens'] = mesure.tokens(row.get('usage'))
    if row.get('started_at') and row.get('finished_at'):
        # call_logs (lecture seule) : une ligne par appel, avec l'étiquette de conversation OmniRoute.
        # tokens_in y inclut lus + écrits. Les appels d'autres clients de la même clé pendant la fenêtre
        # sont écartés : omniroute_native = UNE conversation par run (l'étiquette dominante) ;
        # claude_local = toutes les étiquettes de la fenêtre (le CLI fait des appels annexes).
        rows = infra.omniroute_sql(
            "select timestamp, model, path, coalesce(session_tag,''), combo_name, tokens_in, coalesce(tokens_cache_read,0), "
            "coalesce(tokens_cache_creation,0), tokens_out from call_logs "
            f"where api_key_name='{CFG['omnirouteKeyName']}' "
            f"and timestamp between '{_utc(row['started_at'])}' and '{_utc(row['finished_at'])}' order by timestamp;")
        row['omniroute'] = mesure.call_logs_summary(rows, adapter=adapter,
                                                    combo=(row.get('usage') or {}).get('requestedModel'),
                                                    prix=CFG.get('prixOmnirouteUsdParMillion'))
    return row


def _utc(ts: str) -> str:
    return dt.datetime.fromisoformat(ts).astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def collect_facts(task: dict, iid: str, checks: list[dict], runs: list[dict]) -> dict:
    root = CFG['workspaceRoot']
    faits = {'agent_id': CFG['agentId'], 'runs': runs,
             'issue_status': infra.sql(f"select status from issues where id='{iid}';"),
             'comments': infra.sql_lines(
                 "select json_build_object('author_agent',author_agent_id,'body',body,'created_at',created_at) "
                 f"from issue_comments where issue_id='{iid}' order by created_at;"),
             'files': {}, 'git': {}}
    for path in criteres.files_needed(checks):
        faits['files'][path] = infra.container_read(f'{root}/{path}')
    for depot in criteres.git_needed(checks):
        d = f'{root}/{depot}'
        out = infra.container_sh(
            f"git -c safe.directory='*' -C '{d}' log --name-only --format='commit %s' 2>&1 | head -20; echo '§§'; "
            f"git -c safe.directory='*' -C '{d}' remote -v 2>/dev/null")
        log, _, remote = out.partition('§§')
        faits['git'][depot] = {'log': log, 'remote': remote}
    docs = infra.sql_lines(
        "select json_build_object('key',d.key,'body',x.latest_body) from issue_documents d join documents x on x.id=d.document_id "
        f"where d.issue_id='{iid}';")
    faits['documents'] = {d['key']: d['body'] for d in docs}
    faits['subissues'] = infra.sql_lines(
        "select json_build_object('identifier',identifier,'title',title,'assignee',assignee_agent_id,'status',status) "
        f"from issues where parent_id='{iid}';")
    return faits


def run_task(task: dict, adapter: str, out_dir: pathlib.Path, expected_fp: str) -> dict:
    st = agent_state()
    if st['adapter_type'] != adapter or st['empreinte'] != expected_fp:
        raise SystemExit(f"BLOQUANT : configuration de l'agent modifiée pendant le banc "
                         f"({st['adapter_type']}, empreinte {st['empreinte']} ≠ {expected_fp}) — arrêt.")
    stamp = dt.datetime.now().strftime('%m%d%H%M')
    tag = f"{task['id']}-{SHORT[adapter]}-{stamp}"
    dir_ = f'banc/{tag}'
    prompt = criteres.render(task['prompt'], tag, dir_) + (
        f"\n\n(Banc de mesure {tag} — si tu dois écrire des fichiers, uniquement sous `{dir_}/` dans le workspace.)")
    checks = criteres.render(task['verifs'], tag, dir_)
    since = infra.sql('select now();')
    issue = infra.api('POST', f"/companies/{CFG['companyId']}/issues", {
        'title': f"[Banc] {task['id']} {task['titre']} — {adapter} ({tag})", 'description': prompt,
        'status': 'todo', 'priority': 'low', 'assigneeAgentId': CFG['agentId'], 'projectId': CFG['projectId'],
        'goalId': CFG['goalId'], 'parentId': CFG['parentIssueId']})
    iid = issue['id']
    print(f"[{task['id']}] {adapter} ticket {issue.get('identifier')} tag {tag}", flush=True)
    t0 = time.time()
    waves = [wait_wave(iid, since)]
    if task.get('suivi') and not waves[0]['timeout']:
        since2 = infra.sql('select now();')
        infra.api('POST', f'/issues/{iid}/comments', {'body': criteres.render(task['suivi'], tag, dir_)})
        waves.append(wait_wave(iid, since2))
    run_ids = []
    for w in waves:
        run_ids += [r['id'] for r in w['runs'] if r['id'] not in run_ids]
    runs = [run_details(rid, adapter) for rid in run_ids]
    faits = collect_facts(task, iid, checks, runs)
    verdict = criteres.evaluate(checks, faits)
    res = {'tache': task['id'], 'titre': task['titre'], 'adaptateur': adapter, 'tag': tag,
           'ticket': issue.get('identifier'), 'issueId': iid, 'mur_s': round(time.time() - t0),
           'timeout': any(w['timeout'] for w in waves), 'vagues': len(waves),
           'statut_ticket': faits['issue_status'], 'critere': verdict,
           'commentaires_agent': [len(c['body']) for c in faits['comments'] if c.get('author_agent')],
           'runs': runs, 'resume': rapport.summarize_runs(runs)}
    (out_dir / f'{tag}.json').write_text(json.dumps(res, indent=1, ensure_ascii=False, default=str))
    print(f"[{task['id']}] réussite={verdict['reussi']} {json.dumps(res['resume'], ensure_ascii=False)}", flush=True)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run'); r.add_argument('--adaptateur', required=True, choices=list(SHORT))
    r.add_argument('--sortie', required=True); r.add_argument('--taches')
    p = sub.add_parser('rapport'); p.add_argument('--sortie', required=True)
    m = sub.add_parser('remesurer', help='réanalyse les runs d\'un résultat (après correction du parseur)')
    m.add_argument('--sortie', required=True)
    a = ap.parse_args()
    out = pathlib.Path(a.sortie); out.mkdir(parents=True, exist_ok=True)
    if a.cmd == 'remesurer':
        for f in sorted(out.glob('T*.json')):
            res = json.loads(f.read_text())
            if 'runs' not in res:
                continue
            res['runs'] = [run_details(r['id'], res['adaptateur']) for r in res['runs']]
            res['resume'] = rapport.summarize_runs(res['runs'])
            f.write_text(json.dumps(res, indent=1, ensure_ascii=False, default=str)); print('remesuré', f.name)
        return
    if a.cmd == 'rapport':
        md = rapport.table([json.loads(f.read_text()) for f in sorted(out.glob('T*.json'))])
        (out / 'tableau.md').write_text(md); print(md); return
    st = agent_state()
    if st['adapter_type'] != a.adaptateur:
        raise SystemExit(f"l'agent est en {st['adapter_type']}, pas en {a.adaptateur} : basculer d'abord (bench/agent.py).")
    expected = st['empreinte']
    print('empreinte de configuration', expected, flush=True)
    for task in load_tasks(a.taches.split(',') if a.taches else None):
        try:
            run_task(task, a.adaptateur, out, expected)
        except SystemExit:
            raise
        except Exception as e:  # une tâche en erreur n'arrête pas le banc
            print(f"[{task['id']}] ERREUR du lanceur : {e}", flush=True)
            (out / f"{task['id']}-{SHORT[a.adaptateur]}-erreur.json").write_text(
                json.dumps({'tache': task['id'], 'adaptateur': a.adaptateur, 'erreur_lanceur': str(e), 'at': now_iso()}))


if __name__ == '__main__':
    main()
