"""Offline audit of the verbatim licence texts against the pinned inventory."""
import hashlib
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class NoticeTests(unittest.TestCase):
    def test_all_inventory_texts_have_original_byte_hash(self):
        inventory = json.loads((ROOT / 'third-party-inventory.json').read_text())
        md = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        self.assertEqual(len(inventory['components']), inventory['summary']['entries'])
        for component in inventory['components']:
            with self.subTest(component=component['name']):
                self.assertIn(f"### {component['name']}@{component['version']}\n", md)
                for file in component['files']:
                    # Text is verbatim except LF normalization and trailing newlines.
                    start = md.index('(sha256 `' + file['sha256'] + '`)')
                    match = re.search(r'(`{3,})text\n(.*?)\n\1', md[start:], re.S)
                    if match is None:
                        self.fail('Missing licence text block')
                    text = match.group(2)
                    candidates = [text + '\n' * n for n in range(4)]
                    candidates += [s.replace('\n', '\r\n') for s in candidates]
                    hashes = {hashlib.sha256(s.encode()).hexdigest() for s in candidates}
                    self.assertIn(file['sha256'], hashes, file.get('path_in_tarball', file.get('url')))

    def test_package_carries_same_notices_and_project_license(self):
        package = ROOT / 'packages/adapters/omniroute-native'
        for file in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
            self.assertEqual((ROOT / file).read_bytes(), (package / file).read_bytes())
        manifest = json.loads((package / 'package.json').read_text())
        self.assertIn('THIRD_PARTY_NOTICES.md', manifest['files'])


if __name__ == '__main__':
    unittest.main()
