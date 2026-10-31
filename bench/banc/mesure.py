"""Analyse pure (sans réseau) des journaux de run et de l'usage : testable hors ligne.

Formats reconnus dans le journal ndjson Paperclip (une ligne = {stream, chunk}) :
- omniroute_native : lignes JSON `{"kind":"tool_call"|"tool_result"|"assistant", ...}` ;
- claude_local (stream-json du CLI) : `{"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","is_error":...}]}}`, `{"type":"result",...}`.
"""
from __future__ import annotations

import json
import re

REFUS_PREFIX = 'Refusé :'
# Refus du garde-fou shell/fichiers (tools.ts) ; les autres « Refusé : » (chemin vide, parent introuvable…)
# sont des erreurs d'outil ordinaires.
GARDE_FOU = ('sortie du workspace', 'publication distante', 'accès refusé')
CURL_RE = re.compile(r'(^|[\s;&|(`$"\'])curl(\s|$)')


def _chunks_to_events(ndjson_text: str):
    """Recompose les sorties stdout (découpées en chunks) puis les lit ligne à ligne."""
    buf = []
    for line in ndjson_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get('stream') == 'stdout' and isinstance(entry.get('chunk'), str):
            buf.append(entry['chunk'])
    for raw in ''.join(buf).splitlines():
        raw = raw.strip()
        if not raw.startswith('{'):
            continue
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            continue


def _tool_result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(c.get('text', '') if isinstance(c, dict) else str(c) for c in content)
    return ''


def analyse_log(ndjson_text: str) -> dict:
    """Compte appels d'outils, `curl`, refus du garde-fou, erreurs d'outil, modèles vus."""
    stats = {'tool_calls': 0, 'tools': {}, 'curl': 0, 'refus_garde_fou': 0, 'erreurs_outil': 0,
             'modeles_vus': [], 'num_turns': None, 'refus_exemples': []}
    models = []

    def add_call(name: str, command: str | None):
        stats['tool_calls'] += 1
        stats['tools'][name] = stats['tools'].get(name, 0) + 1
        if command and CURL_RE.search(command):
            stats['curl'] += 1

    def add_result(text: str, is_error: bool):
        if text.startswith(REFUS_PREFIX) and any(g in text for g in GARDE_FOU):
            stats['refus_garde_fou'] += 1
            if len(stats['refus_exemples']) < 3:
                stats['refus_exemples'].append(text[:160])
        if is_error:
            stats['erreurs_outil'] += 1

    acpx: dict[str, dict] = {}  # claude_local via ACP : un appel = un toolCallId, mis à jour plusieurs fois
    for ev in _chunks_to_events(ndjson_text):
        if ev.get('type') == 'acpx.tool_call' and ev.get('toolCallId'):
            a = acpx.setdefault(ev['toolCallId'], {'names': [], 'status': None, 'text': ''})
            a['names'].append(str(ev.get('name') or ''))
            if ev.get('status'):
                a['status'] = ev['status']
                if ev['status'] in ('completed', 'failed'):
                    a['text'] = str(ev.get('text') or '')
            continue
        kind = ev.get('kind')
        if kind == 'tool_call':
            inp = ev.get('input') or {}
            add_call(str(ev.get('name')), inp.get('command') if isinstance(inp, dict) else None)
            continue
        if kind == 'tool_result':
            add_result(_tool_result_text(ev.get('content')), bool(ev.get('isError')))
            continue
        typ = ev.get('type')
        if typ == 'system' and ev.get('model'):
            models.append(ev['model'])
        if typ in ('assistant', 'user'):
            msg = ev.get('message') or {}
            if typ == 'assistant' and msg.get('model'):
                models.append(msg['model'])
            for part in msg.get('content') or []:
                if not isinstance(part, dict):
                    continue
                if part.get('type') == 'tool_use':
                    inp = part.get('input') or {}
                    add_call(str(part.get('name')), inp.get('command') if isinstance(inp, dict) else None)
                elif part.get('type') == 'tool_result':
                    add_result(_tool_result_text(part.get('content')), bool(part.get('is_error')))
        if typ == 'result':
            stats['num_turns'] = ev.get('num_turns', stats['num_turns'])
            for m in (ev.get('modelUsage') or {}):
                models.append(m)
    for a in acpx.values():
        name = a['names'][0] if a['names'] else '?'
        command = next((n for n in a['names'] if CURL_RE.search(n)), None)
        add_call(name, command)
        if a['status'] == 'failed':
            stats['erreurs_outil'] += 1
    seen = []
    for m in models:
        if m not in seen:
            seen.append(m)
    stats['modeles_vus'] = seen
    return stats


def tokens(usage: dict | None) -> dict:
    """Tokens normalisés : entrée non servie par le cache, lue en cache, écrite, sortie, part de cache.

    Convention Paperclip (vérifiée sur ACC-2305) : `inputTokens` exclut les tokens lus en cache
    (`rawInputIncludesCached=false`) et inclut l'écriture de cache. La part de cache est
    lus / (entrée + lus) = part du prompt total servie par le cache.
    """
    u = usage or {}
    inp = int(u.get('inputTokens') or 0)
    cached = int(u.get('cachedInputTokens') or 0)
    write = int(u.get('cacheWriteTokens') or 0)
    out = int(u.get('outputTokens') or 0)
    if u.get('rawInputIncludesCached'):
        inp = max(inp - cached, 0)
    total = inp + cached
    return {'entree': inp, 'lus_cache': cached, 'ecrits_cache': write, 'sortie': out,
            'prompt_total': total, 'part_cache': round(cached / total, 4) if total else None}


def omniroute_rows_summary(rows: list[list[str]]) -> dict:
    """Résumé des lignes usage_history (timestamp, model, endpoint, combo, in, read, creation, out)."""
    models: dict[str, int] = {}
    endpoints: dict[str, int] = {}
    tin = read = create = out = 0
    for r in rows:
        _, model, endpoint, _combo, a, b, c, d = (r + [''] * 8)[:8]
        models[model] = models.get(model, 0) + 1
        endpoints[endpoint] = endpoints.get(endpoint, 0) + 1
        tin += int(a or 0); read += int(b or 0); create += int(c or 0); out += int(d or 0)
    # OmniRoute : tokens_input = frais + lus (sans l'écriture de cache, comptée à part).
    total = tin + create
    return {'appels': len(rows), 'modeles': models, 'endpoints': endpoints, 'tokens_input': tin,
            'cache_read': read, 'cache_creation': create, 'output': out,
            'part_cache': round(read / total, 4) if total else None}


def call_logs_summary(rows: list[list[str]], adapter: str, combo: str | None = None, prix: dict | None = None) -> dict:
    """Résumé des appels OmniRoute d'un run, à partir de call_logs.

    Colonnes : timestamp, model, path, session_tag, combo_name, tokens_in, lus, écrits, sortie.
    Sémantique de tokens_in mesurée le 31/10 (OmniRoute 3.8.53) : sur /v1/messages = frais + lus + écrits ;
    sur /v1/chat/completions en streaming (adaptateur natif) = frais + lus, les écrits à part
    (`cache_creation_in_prompt: false`). Le prompt total est donc tokens_in (+ écrits en Chat Completions).
    Voir lancer.run_details pour le choix des étiquettes retenues.
    """
    by_tag: dict[str, list] = {}
    for r in rows:
        r = (r + [''] * 9)[:9]
        by_tag.setdefault(r[3], []).append(r)
    if not by_tag:
        return {'appels': 0, 'modeles': {}, 'endpoints': {}, 'tokens_input': 0, 'cache_read': 0,
                'cache_creation': 0, 'output': 0, 'part_cache': None, 'etiquettes': {}, 'ecartes': 0}
    if adapter == 'omniroute_native':
        keep = [max(by_tag, key=lambda t: len(by_tag[t]))]
    else:
        keep = list(by_tag)
    kept = [r for t in keep for r in by_tag[t]]
    models: dict[str, int] = {}
    endpoints: dict[str, int] = {}
    total = read = create = out = 0
    cout, cout_connu = 0.0, True
    for _, model, path, _tag, _combo, a, b, c, d in kept:
        models[model] = models.get(model, 0) + 1
        endpoints[path] = endpoints.get(path, 0) + 1
        a, b, c = int(a or 0), int(b or 0), int(c or 0)
        total += a if path.endswith('/messages') else a + c
        read += b; create += c; out += int(d or 0)
        p = (prix or {}).get(model)
        if p:
            fresh = (a if path.endswith('/messages') else a + c) - b - c
            cout += (fresh * p['frais'] + b * p['lus'] + c * p['ecrits'] + int(d or 0) * p['sortie']) / 1e6
        else:
            cout_connu = False
    return {'appels': len(kept), 'modeles': models, 'endpoints': endpoints,
            'prompt_total': total, 'frais': total - read - create, 'cache_read': read, 'cache_creation': create,
            'output': out, 'cout_tarif_omniroute_usd': round(cout, 4) if cout_connu else None, 'part_cache': round(read / total, 4) if total else None,
            'etiquettes': {t: len(v) for t, v in by_tag.items()}, 'ecartes': len(rows) - len(kept)}
