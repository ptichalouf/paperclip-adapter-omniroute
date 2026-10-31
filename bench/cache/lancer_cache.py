"""Banc de cache OmniRoute : rejoue un préfixe stable (~10 k tokens) 3 fois par cas et mesure le cache.

  python3 bench/cache/lancer_cache.py --sortie <dossier> [--cas C1,M1]

Le script node est copié dans le conteneur paperclip sous /tmp/banc-cache-*.mjs, exécuté avec la clé
du conteneur (jamais affichée), puis supprimé. Au plus 90 appels ; entrées ≤ 20 000 tokens.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import shlex
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from banc import infra  # noqa: E402

MAX_CALLS = 90


def part_cache(u: dict) -> float | None:
    """Part du prompt servie par le cache, quel que soit le format de réponse."""
    read = u.get('cache_read_input_tokens')
    if read is None:
        read = u.get('cached_tokens')
    read = read or 0
    create = u.get('cache_creation_input_tokens') or 0
    if u.get('input_tokens') is not None:  # format Anthropic : input exclut lus et écrits
        total = (u.get('input_tokens') or 0) + read + create
    else:  # Chat Completions : prompt_tokens inclut les lus
        total = (u.get('prompt_tokens') or 0)
        if u.get('creation_in_prompt') is False:
            total += create
        if u.get('cache_read_input_tokens') is not None and total < read:
            total += read
    return round(read / total, 4) if total else None


def summarize(rows: list[dict], cases: list[dict]) -> str:
    by = {}
    for r in rows:
        by.setdefault(r['id'], []).append(r)
    lines = ['| Cas | API | Modèle demandé | Ordre | Session | cache_control | Appel 1 | Appel 2 | Appel 3 | Modèle(s) servi(s) | Coût par appel (x-omniroute-response-cost) | Erreurs |',
             '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for c in cases:
        rs = sorted(by.get(c['id'], []), key=lambda r: r['call'])
        cells = []
        for r in rs:
            u = r.get('usage') or {}
            p = part_cache(u)
            lu = u.get('cache_read_input_tokens') if u.get('cache_read_input_tokens') is not None else u.get('cached_tokens')
            cells.append(f"{'—' if p is None else f'{p * 100:.0f} %'} (lus {lu}, écrits {u.get('cache_creation_input_tokens')})")
        while len(cells) < 3:
            cells.append('—')
        served = sorted({str(r.get('modele_servi')) for r in rs})
        costs = ' / '.join(f"{float(c):.4f} $" if c else '—' for c in ((r.get('entetes') or {}).get('x-omniroute-response-cost') for r in rs))
        errs = [f"{r.get('http')} {r.get('erreur', '')[:60]}" for r in rs if r.get('erreur') or r.get('http') != 200]
        lines.append(f"| {c['id']} | {c['api']} | {c['model']} | {c['ordre']} | {'oui' if c.get('session') else 'non'} | "
                     f"{'oui' if c.get('cacheControl') else 'non'} | {' | '.join(cells[:3])} | {', '.join(served)} | {costs or '—'} | {'; '.join(errs) or '—'} |")
    return '\n'.join(lines) + '\n'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--sortie', required=True)
    ap.add_argument('--cas')
    ap.add_argument('--tableau', action='store_true', help='regroupe tous les cache-*.json du dossier en un tableau')
    a = ap.parse_args()
    out = pathlib.Path(a.sortie); out.mkdir(parents=True, exist_ok=True)
    cases = json.loads((HERE / 'cas.json').read_text())
    if a.tableau:
        rows, known = [], {}
        for f in sorted(out.glob('cache-*.json')):
            d = json.loads(f.read_text()); rows += d['resultats']
            known.update({c['id']: c for c in d['cas']})
        md = summarize(rows, [c for c in cases if c['id'] in known])
        (out / 'tableau-cache.md').write_text(md); print(md); return
    if a.cas:
        cases = [c for c in cases if c['id'] in a.cas.split(',')]
    total = sum(c.get('calls', 3) for c in cases)
    if total > MAX_CALLS:
        raise SystemExit(f'{total} appels > {MAX_CALLS}')
    stamp = dt.datetime.now().strftime('%Y%m%d%H%M%S')
    remote = f'/tmp/banc-cache-{stamp}.mjs'
    script = (HERE / 'banc-cache.mjs').read_text()
    debut = dt.datetime.now(dt.timezone.utc).isoformat()
    infra.ssh(infra.PAPERCLIP_SSH, f"docker exec -i paperclip sh -c {shlex.quote(f'cat > {remote}')}", stdin=script)
    try:
        raw = infra.ssh(infra.PAPERCLIP_SSH,
                        f"docker exec paperclip node {remote} {shlex.quote(json.dumps(cases))}", timeout=3600)
    finally:
        infra.ssh(infra.PAPERCLIP_SSH, f'docker exec paperclip rm -f {remote}')
        left = infra.ssh(infra.PAPERCLIP_SSH, "docker exec paperclip sh -c 'ls /tmp/banc-cache-* 2>/dev/null | wc -l'").strip()
        print('fichiers /tmp/banc-cache-* restants dans le conteneur :', left)
    fin = dt.datetime.now(dt.timezone.utc).isoformat()
    rows = [json.loads(x) for x in raw.splitlines() if x.strip().startswith('{')]
    for r in rows:
        r['part_cache'] = part_cache(r.get('usage') or {})
    # Complément : journal d'usage OmniRoute (lecture seule) sur la fenêtre du banc, clé du conteneur.
    def utc(s):
        return dt.datetime.fromisoformat(s).astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    usage = infra.omniroute_sql(
        "select timestamp, provider, model, endpoint, combo_strategy, tokens_input, tokens_cache_read, tokens_cache_creation, tokens_output "
        f"from usage_history where api_key_name='{infra.CONFIG['omnirouteKeyName']}' and timestamp between '{utc(debut)}' and '{utc(fin)}Z' order by timestamp;")
    res = {'debut': debut, 'fin': fin, 'appels': len(rows), 'cas': cases, 'resultats': rows, 'usage_history': usage}
    (out / f'cache-{stamp}.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
    md = summarize(rows, cases)
    (out / f'cache-{stamp}.md').write_text(md)
    print(md)


if __name__ == '__main__':
    main()
