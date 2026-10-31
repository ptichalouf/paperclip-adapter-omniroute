"""Tests hors ligne du banc (aucun réseau) : python3 -m unittest discover -s bench -p 'test_*.py'"""
import json
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'cache'))

from banc import criteres, mesure, rapport  # noqa: E402
import lancer_cache  # noqa: E402


def ndjson(*events):
    return '\n'.join(json.dumps({'stream': 'stdout', 'chunk': json.dumps(e) + '\n'}) for e in events)


class TestMesure(unittest.TestCase):
    def test_omniroute_log(self):
        log = ndjson(
            {'kind': 'tool_call', 'name': 'shell', 'input': {'command': 'H=x; curl -s "$U/api"'}},
            {'kind': 'tool_result', 'content': 'Refusé : sortie du workspace interdite : « /tmp »', 'isError': True},
            {'kind': 'tool_call', 'name': 'shell', 'input': {'command': 'ls'}},
            {'kind': 'tool_result', 'content': 'Refusé : répertoire parent introuvable : x', 'isError': True},
        )
        s = mesure.analyse_log(log)
        self.assertEqual((s['tool_calls'], s['curl'], s['refus_garde_fou'], s['erreurs_outil']), (2, 1, 1, 2))

    def test_claude_stream_json(self):
        log = ndjson(
            {'type': 'system', 'model': 'AC-pro-coding'},
            {'type': 'assistant', 'message': {'model': 'claude-opus-5-5', 'content': [
                {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'curl -s x | jq .'}}]}},
            {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'is_error': True, 'content': 'boom'}]}},
            {'type': 'result', 'num_turns': 4, 'modelUsage': {'claude-opus-5-5': {}}},
        )
        s = mesure.analyse_log(log)
        self.assertEqual((s['curl'], s['erreurs_outil'], s['num_turns']), (1, 1, 4))
        self.assertEqual(s['modeles_vus'], ['AC-pro-coding', 'claude-opus-5-5'])

    def test_claude_acpx(self):
        log = ndjson(
            {'type': 'acpx.tool_call', 'name': 'Terminal', 'toolCallId': 't1', 'status': 'pending'},
            {'type': 'acpx.tool_call', 'name': 'curl -s "$B/api/issues"', 'toolCallId': 't1'},
            {'type': 'acpx.tool_call', 'name': 'Terminal', 'toolCallId': 't1', 'status': 'completed', 'text': 'ok'},
            {'type': 'acpx.tool_call', 'name': 'Edit', 'toolCallId': 't2', 'status': 'pending'},
            {'type': 'acpx.tool_call', 'name': 'Edit', 'toolCallId': 't2', 'status': 'failed', 'text': 'non'},
        )
        s = mesure.analyse_log(log)
        self.assertEqual((s['tool_calls'], s['curl'], s['erreurs_outil']), (2, 1, 1))

    def test_chunks_decoupes(self):
        line = json.dumps({'kind': 'tool_call', 'name': 'shell', 'input': {'command': 'curl x'}}) + '\n'
        log = '\n'.join(json.dumps({'stream': 'stdout', 'chunk': c}) for c in (line[:20], line[20:]))
        self.assertEqual(mesure.analyse_log(log)['curl'], 1)

    def test_tokens_acc2305(self):
        t = mesure.tokens({'inputTokens': 54585, 'cachedInputTokens': 177733, 'cacheWriteTokens': 34004,
                           'outputTokens': 12531, 'rawInputIncludesCached': False})
        self.assertEqual(t['prompt_total'], 232318)
        self.assertAlmostEqual(t['part_cache'], 0.765, places=3)

    def test_omniroute_rows(self):
        s = mesure.omniroute_rows_summary([['t', 'claude-opus-5-5', '/v1/chat/completions', 'priority', '198314', '177733', '34004', '12531']])
        self.assertAlmostEqual(s['part_cache'], 0.765, places=3)


class TestCallLogs(unittest.TestCase):
    rows = [['t1', 'claude-opus-5-5', '/v1/chat/completions', 'conv_a', 'AC-pro-coding', '1000', '0', '900', '10'],
            ['t2', 'claude-opus-5-5', '/v1/chat/completions', 'conv_a', 'AC-pro-coding', '1100', '900', '150', '10'],
            ['t3', 'MiniMax', '/v1/chat/completions', 'conv_x', 'AC-task', '500', '0', '0', '5']]

    def test_native_garde_la_conversation_dominante(self):
        s = mesure.call_logs_summary(self.rows, 'omniroute_native')
        self.assertEqual((s['appels'], s['cache_read'], s['cache_creation'], s['ecartes']), (2, 900, 1050, 1))
        self.assertEqual(s['prompt_total'], 1000 + 900 + 1100 + 150)  # chat : écrits hors tokens_in
        self.assertAlmostEqual(s['part_cache'], 900 / 3150, places=4)

    def test_messages_tokens_in_inclut_les_ecrits(self):
        s = mesure.call_logs_summary([['t', 'm', '/v1/messages', 'c', 'AC', '12970', '0', '12952', '4']], 'claude_local')
        self.assertEqual((s['prompt_total'], s['frais']), (12970, 18))

    def test_cout_tarif_omniroute(self):
        prix = {'claude-opus-5-5': {'frais': 4.0, 'lus': 0.2, 'ecrits': 5.0, 'sortie': 20.0}}
        r1 = [['t', 'claude-opus-5-5', '/v1/messages', 'c', 'AC', '12970', '0', '12952', '4']]
        r2 = [['t', 'claude-opus-5-5', '/v1/messages', 'c', 'AC', '12970', '12952', '0', '4']]
        # en-têtes x-omniroute-response-cost mesurés : 0,064907 et 0,0027422 $
        self.assertAlmostEqual(mesure.call_logs_summary(r1, 'claude_local', prix=prix)['cout_tarif_omniroute_usd'], 0.0649, places=4)
        self.assertAlmostEqual(mesure.call_logs_summary(r2, 'claude_local', prix=prix)['cout_tarif_omniroute_usd'], 0.0027, places=4)
        self.assertIsNone(mesure.call_logs_summary(r1, 'claude_local')['cout_tarif_omniroute_usd'])

    def test_claude_local_garde_tout(self):
        self.assertEqual(mesure.call_logs_summary(self.rows, 'claude_local')['appels'], 3)


class TestCriteres(unittest.TestCase):
    def faits(self, **kw):
        base = {'agent_id': 'A', 'runs': [{'status': 'succeeded'}], 'issue_status': 'done',
                'comments': [{'author_agent': 'A', 'body': 'Le coordinateur et les spécialistes ' + 'x' * 900}],
                'files': {}, 'git': {}, 'documents': {}, 'subissues': []}
        base.update(kw)
        return base

    def test_render(self):
        c = criteres.render([{'chemin': '{dir}/a', 't': 'banc {tag}'}], 'T1-on', 'banc/T1-on')
        self.assertEqual(c, [{'chemin': 'banc/T1-on/a', 't': 'banc T1-on'}])

    def test_avis(self):
        task = json.loads((HERE / 'taches' / 'T01.json').read_text())
        self.assertTrue(criteres.evaluate(task['verifs'], self.faits())['reussi'])
        self.assertFalse(criteres.evaluate(task['verifs'], self.faits(comments=[]))['reussi'])

    def test_json_egal_et_lignes(self):
        checks = [{'type': 'fichier', 'chemin': 'c.json', 'json_egal': {'version': 2}},
                  {'type': 'fichier', 'chemin': 'r.txt', 'lignes_basename': ['j03.log', 'j10.log']}]
        f = self.faits(files={'c.json': '{"version": 2}\n', 'r.txt': 'banc/x/journaux/j10.log\nj03.log\n'})
        self.assertTrue(criteres.evaluate(checks, f)['reussi'])
        f['files']['r.txt'] = 'j03.log\n'
        self.assertFalse(criteres.evaluate(checks, f)['reussi'])

    def test_json_champs_skill(self):
        task = json.loads((HERE / 'taches' / 'T06.json').read_text())
        checks = criteres.render(task['verifs'], 't', 'd')
        good = json.dumps({'liberer': 'POST /api/issues/:issueId/release', 'bloqueurs': 'blockedByIssueIds',
                           'recherche': 'q', 'statut_attente_revue': 'in_review'})
        self.assertTrue(criteres.evaluate(checks, self.faits(files={'d/reponses.json': good}))['reussi'])
        bad = json.dumps({'liberer': 'POST /api/issues/:id/release', 'bloqueurs': 'blockers', 'recherche': 'q',
                          'statut_attente_revue': 'in_review'})
        r = criteres.evaluate(checks, self.faits(files={'d/reponses.json': bad}))
        self.assertFalse(r['reussi'])

    def test_sous_tache_et_git(self):
        checks = [{'type': 'sous_tache', 'titre_contient': 'Sous-tâche banc t', 'assignee_agent': True, 'identifiant_commente': True},
                  {'type': 'git_commit', 'depot': 'd', 'fichier': 'NOTE.md', 'sans_distant': True}]
        f = self.faits(subissues=[{'identifier': 'ACC-9', 'title': 'Sous-tâche banc t', 'assignee': 'A'}],
                       comments=[{'author_agent': 'A', 'body': 'créée : ACC-9'}],
                       git={'d': {'log': 'commit banc : note\n\nNOTE.md\n', 'remote': ''}})
        self.assertTrue(criteres.evaluate(checks, f)['reussi'])
        f['git']['d']['remote'] = 'origin http://x (push)'
        self.assertFalse(criteres.evaluate(checks, f)['reussi'])

    def test_toutes_les_taches_sont_valides(self):
        tasks = [json.loads(p.read_text()) for p in sorted((HERE / 'taches').glob('T*.json'))]
        self.assertTrue(8 <= len(tasks) <= 10)
        known = {'run_reussi', 'runs_min', 'statut_ticket', 'commentaire_agent', 'fichier', 'json_champs',
                 'document', 'sous_tache', 'git_commit'}
        for t in tasks:
            self.assertTrue(t['prompt'] and t['verifs'])
            self.assertTrue({c['type'] for c in t['verifs']} <= known, t['id'])


class TestRapport(unittest.TestCase):
    def test_table(self):
        run = {'status': 'succeeded', 'turns': 5, 'dur': 60, 'tokens': mesure.tokens({'inputTokens': 100, 'cachedInputTokens': 900}),
               'usage': {'model': 'claude-opus-5-5', 'costUsd': None, 'costStatus': 'unpriced'},
               'log': {'curl': 2, 'refus_garde_fou': 0, 'erreurs_outil': 1}, 'final_disposition': 'final'}
        res = {'tache': 'T01', 'titre': 'Avis', 'adaptateur': 'omniroute_native', 'ticket': 'ACC-1', 'statut_ticket': 'done',
               'critere': {'reussi': True, 'details': []}, 'commentaires_agent': [900], 'resume': rapport.summarize_runs([run])}
        md = rapport.table([res])
        self.assertIn('| T01 Avis | omniroute_native | ACC-1 | OUI', md)
        self.assertIn('90 %', md)


class TestCache(unittest.TestCase):
    def test_part_cache_formats(self):
        self.assertEqual(lancer_cache.part_cache({'prompt_tokens': 12969, 'cached_tokens': 12951}), round(12951 / 12969, 4))
        self.assertEqual(lancer_cache.part_cache({'prompt_tokens': 18, 'cache_creation_input_tokens': 12951,
                                                  'creation_in_prompt': False}), 0.0)
        self.assertEqual(lancer_cache.part_cache({'input_tokens': 10, 'cache_read_input_tokens': 90,
                                                  'cache_creation_input_tokens': 0}), 0.9)

    def test_budget_appels(self):
        cases = json.loads((HERE / 'cache' / 'cas.json').read_text())
        self.assertLessEqual(sum(c.get('calls', 3) for c in cases), lancer_cache.MAX_CALLS)


if __name__ == '__main__':
    unittest.main()
