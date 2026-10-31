"""Agrégation et tableau Markdown comparatif (fonctions pures)."""
from __future__ import annotations


def summarize_runs(runs: list[dict]) -> dict:
    tot = {'entree': 0, 'lus_cache': 0, 'ecrits_cache': 0, 'sortie': 0}
    cost, cost_status, models, turns, dur = 0.0, set(), [], 0, 0.0
    curl = refus = errs = 0
    om = {'appels': 0, 'lus': 0, 'ecrits': 0, 'entree': 0, 'cout': 0.0, 'cout_connu': True}
    cost_known = True
    for r in runs:
        t = r.get('tokens') or {}
        for k in tot:
            tot[k] += int(t.get(k) or 0)
        u = r.get('usage') or {}
        if u.get('costUsd') is None:
            cost_known = False
        else:
            cost += float(u['costUsd'])
        if u.get('costStatus'):
            cost_status.add(u['costStatus'])
        for m in [u.get('model')] + list((u.get('usageByModel') or {}) or []) + list(((r.get('omniroute') or {}).get('modeles') or {}).keys()):
            if m and m not in models:
                models.append(m)
        try:
            turns += int(r.get('turns') or 0)
        except (TypeError, ValueError):
            pass
        dur += float(r.get('dur') or 0)
        o = r.get('omniroute') or {}
        if o.get('cout_tarif_omniroute_usd') is None:
            om['cout_connu'] = False
        else:
            om['cout'] += o['cout_tarif_omniroute_usd']
        om['appels'] += o.get('appels', 0); om['lus'] += o.get('cache_read', 0)
        om['ecrits'] += o.get('cache_creation', 0); om['entree'] += o.get('prompt_total', o.get('tokens_input', 0))
        lg = r.get('log') or {}
        curl += lg.get('curl', 0); refus += lg.get('refus_garde_fou', 0); errs += lg.get('erreurs_outil', 0)
    total = tot['entree'] + tot['lus_cache']
    return {'runs': len(runs), 'statuts': [r.get('status') for r in runs], 'tours': turns, 'duree_s': round(dur, 1),
            **tot, 'part_cache': round(tot['lus_cache'] / total, 4) if total else None,
            'cout_usd': round(cost, 4) if cost_known and runs else None, 'statut_cout': sorted(cost_status),
            'modeles': models, 'curl': curl, 'refus': refus, 'erreurs_outil': errs,
            'appels_modele': om['appels'], 'omniroute_lus': om['lus'], 'omniroute_ecrits': om['ecrits'],
            'omniroute_prompt_total': om['entree'],
            'cout_tarif_omniroute_usd': round(om['cout'], 4) if om['cout_connu'] and runs else None,
            'omniroute_part_cache': round(om['lus'] / om['entree'], 4) if om['entree'] else None,
            'outils': sum((r.get('log') or {}).get('tool_calls', 0) for r in runs),
            'reponse_finale': [r.get('final_disposition') or ('texte' if r.get('final_text') else None) for r in runs]}


def _pct(x):
    return '—' if x is None else f'{x * 100:.0f} %'


def _usd(x):
    return '—' if x is None else f'{x:.3f} $'


def _k(x):
    return f'{x / 1000:.1f}k'


def table(results: list[dict]) -> str:
    by_task: dict[str, dict] = {}
    for r in results:
        if 'resume' not in r:
            continue
        by_task.setdefault(r['tache'], {})[r['adaptateur']] = r
    head = ('| Tâche | Adaptateur | Ticket | Réussite | Runs (statut) | Statut ticket | Comm. agent | Réponse finale | Appels modèle | Outils | Durée | '
            'Entrée (Paperclip) | Lus cache | Écrits | Sortie | Part cache (Paperclip) | Part cache (OmniRoute) | Coût déclaré (statut) | Coût au tarif OmniRoute | Modèle(s) servi(s) | curl | Refus | Err. outil |')
    lines = [head, '|' + '---|' * (head.count('|') - 1)]
    agg: dict[str, dict] = {}
    for tid in sorted(by_task):
        for ad in ('omniroute_native', 'claude_local'):
            r = by_task[tid].get(ad)
            if not r:
                continue
            s = r['resume']
            a = agg.setdefault(ad, {'n': 0, 'ok': 0, 'tours': 0, 'ol': 0, 'ow': 0, 'cout': 0.0, 'duree': 0.0, 'entree': 0, 'lus': 0, 'curl': 0, 'refus': 0, 'err': 0})
            a['n'] += 1; a['ok'] += int(r['critere']['reussi']); a['tours'] += s.get('appels_modele', 0); a['ol'] += s.get('omniroute_lus', 0); a['ot'] = a.get('ot', 0) + s.get('omniroute_prompt_total', 0); a['ow'] += s.get('omniroute_ecrits', 0); a['cout'] += s['cout_usd'] or 0; a['ct'] = a.get('ct', 0) + (s.get('cout_tarif_omniroute_usd') or 0); a['duree'] += s['duree_s']
            a['entree'] += s['entree']; a['lus'] += s['lus_cache']; a['curl'] += s['curl']; a['refus'] += s['refus']; a['err'] += s['erreurs_outil']
            ko = [d['type'] for d in r['critere']['details'] if not d['ok']]
            ok = 'OUI' if r['critere']['reussi'] else 'NON (' + ', '.join(ko) + ')'
            cost = '—' if s['cout_usd'] is None else f"{s['cout_usd']:.3f} $"
            lines.append(
                f"| {tid} {r['titre']} | {ad} | {r['ticket']} | {ok}{' ⏱' if r.get('timeout') else ''} | {s['runs']} ({', '.join(map(str, s['statuts']))}) | "
                f"{r['statut_ticket']} | {len(r.get('commentaires_agent', []))} | {', '.join(str(x) for x in s['reponse_finale'])} | {s.get('appels_modele', '—')} | {s.get('outils', '—')} | "
                f"{s['duree_s']:.0f} s | {_k(s['entree'])} | {_k(s['lus_cache'])} | {_k(s['ecrits_cache'])} | {_k(s['sortie'])} | "
                f"{_pct(s['part_cache'])} | {_pct(s.get('omniroute_part_cache'))} | {cost} ({', '.join(s['statut_cout']) or '—'}) | {_usd(s.get('cout_tarif_omniroute_usd'))} | {', '.join(s['modeles'])} | "
                f"{s['curl']} | {s['refus']} | {s['erreurs_outil']} |")
    lines.append('')
    lines.append('| Adaptateur | Tâches | Réussies | Appels modèle | Durée totale | Part cache (Paperclip) | Part cache (OmniRoute) | Lus / écrits cache (OmniRoute) | Coût déclaré | Coût au tarif OmniRoute | curl | Refus | Err. outil |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for ad, a in agg.items():
        tot = a['entree'] + a['lus']
        lines.append(f"| {ad} | {a['n']} | {a['ok']}/{a['n']} | {a['tours']} | {a['duree']:.0f} s | "
                     f"{_pct(a['lus'] / tot if tot else None)} | {_pct(a['ol'] / a['ot'] if a.get('ot') else None)} | {_k(a['ol'])} / {_k(a['ow'])} | {a['cout']:.2f} $ | {a.get('ct', 0):.2f} $ | {a['curl']} | {a['refus']} | {a['err']} |")
    return '\n'.join(lines) + '\n'
