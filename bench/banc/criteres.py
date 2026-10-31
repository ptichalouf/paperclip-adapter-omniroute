"""Critères de réussite vérifiables automatiquement (fonctions pures, testées hors ligne).

Chaque tâche déclare une liste de vérifications ; la tâche réussit si toutes passent.
Les faits (`faits`) sont collectés par le lanceur en lecture seule (base, fichiers du workspace).
"""
from __future__ import annotations

import json
import posixpath
import unicodedata


def norm(text: str) -> str:
    """Minuscules sans accents, apostrophes unifiées (comparaison tolérante)."""
    text = unicodedata.normalize('NFKD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return text.replace('’', "'").lower()


def render(value, tag: str, dir_: str):
    if isinstance(value, str):
        return value.replace('{tag}', tag).replace('{dir}', dir_)
    if isinstance(value, list):
        return [render(v, tag, dir_) for v in value]
    if isinstance(value, dict):
        return {k: render(v, tag, dir_) for k, v in value.items()}
    return value


def files_needed(checks: list[dict]) -> list[str]:
    return [c['chemin'] for c in checks if c['type'] in ('fichier', 'json_champs')]


def git_needed(checks: list[dict]) -> list[str]:
    return [c['depot'] for c in checks if c['type'] == 'git_commit']


def _agent_comments(faits):
    return [c for c in faits.get('comments', []) if c.get('author_agent')]


def check_one(check: dict, faits: dict) -> tuple[bool, str]:
    t = check['type']
    if t == 'run_reussi':
        runs = faits.get('runs', [])
        ok = bool(runs) and runs[-1].get('status') == 'succeeded'
        return ok, f"dernier run : {runs[-1].get('status') if runs else 'aucun'}"
    if t == 'runs_min':
        n = len(faits.get('runs', []))
        return n >= check['n'], f'{n} run(s)'
    if t == 'statut_ticket':
        st = faits.get('issue_status')
        return st in check['valeurs'], f'statut {st}'
    if t == 'commentaire_agent':
        for c in _agent_comments(faits):
            body = norm(c.get('body', ''))
            if len(c.get('body', '')) >= check.get('min_len', 1) and all(norm(m) in body for m in check.get('mots', [])):
                return True, f"commentaire de {len(c.get('body', ''))} car."
        return False, f'{len(_agent_comments(faits))} commentaire(s) agent, aucun conforme'
    if t == 'fichier':
        content = faits.get('files', {}).get(check['chemin'])
        if content is None:
            return False, f"{check['chemin']} absent"
        if 'egal' in check:
            return content.strip() == check['egal'].strip(), f'contenu {content.strip()[:60]!r}'
        if 'json_egal' in check:
            try:
                return json.loads(content) == check['json_egal'], f'json {content.strip()[:80]!r}'
            except json.JSONDecodeError:
                return False, 'JSON invalide'
        if 'lignes_basename' in check:
            lines = sorted(posixpath.basename(x.strip()) for x in content.splitlines() if x.strip())
            return lines == sorted(check['lignes_basename']), f'lignes {lines}'
        if 'contient' in check:
            return all(norm(m) in norm(content) for m in check['contient']), f'contenu {content.strip()[:60]!r}'
        return True, 'présent'
    if t == 'json_champs':
        content = faits.get('files', {}).get(check['chemin'])
        if content is None:
            return False, f"{check['chemin']} absent"
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            return False, 'JSON invalide'
        bad = []
        for key, rule in check['champs'].items():
            val = norm(json.dumps(data.get(key), ensure_ascii=False)) if not isinstance(data.get(key), str) else norm(data.get(key))
            if 'egal' in rule and val.strip().strip('`') != norm(rule['egal']):
                bad.append(key)
            if 'contient' in rule and not all(norm(m) in val for m in rule['contient']):
                bad.append(key)
        return not bad, ('champs faux : ' + ', '.join(bad)) if bad else 'tous les champs justes'
    if t == 'document':
        body = (faits.get('documents') or {}).get(check['cle'])
        if body is None:
            return False, f"document {check['cle']} absent"
        ok = all(norm(m) in norm(body) for m in check.get('mots', []))
        return ok, f"document {check['cle']} ({len(body)} car.)"
    if t == 'sous_tache':
        for s in faits.get('subissues', []):
            if norm(check['titre_contient']) in norm(s.get('title', '')):
                if check.get('assignee_agent') and s.get('assignee') != faits.get('agent_id'):
                    return False, f"sous-tâche {s.get('identifier')} mal assignée"
                if check.get('identifiant_commente'):
                    if not any(s.get('identifier', '§') in c.get('body', '') for c in _agent_comments(faits)):
                        return False, f"{s.get('identifier')} non cité en commentaire"
                return True, f"sous-tâche {s.get('identifier')}"
        return False, f"{len(faits.get('subissues', []))} sous-tâche(s), aucune conforme"
    if t == 'git_commit':
        g = (faits.get('git') or {}).get(check['depot']) or {}
        log = g.get('log') or ''
        if check['fichier'] not in log:
            return False, 'aucun commit contenant ' + check['fichier']
        if check.get('sans_distant') and (g.get('remote') or '').strip():
            return False, 'un distant a été ajouté : ' + g['remote'].strip()[:60]
        return True, 'commit local présent' + (', aucun distant' if check.get('sans_distant') else '')
    return False, f'vérification inconnue {t}'


def evaluate(checks: list[dict], faits: dict) -> dict:
    details = []
    for c in checks:
        ok, why = check_one(c, faits)
        details.append({'type': c['type'], 'ok': ok, 'detail': why})
    return {'reussi': all(d['ok'] for d in details), 'details': details}
