"""Regression tests: all fixtures are synthetic and created in disposable Git repositories."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('check-anti-leak.sh')


class AntiLeakTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'scripts').mkdir()
        shutil.copy(SCRIPT, self.root / 'scripts/check-anti-leak.sh')
        implementation = SCRIPT.with_suffix('.py')
        if implementation.exists():
            shutil.copy(implementation, self.root / 'scripts/check-anti-leak.py')

    def scan(self, path, data):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)
        return subprocess.run(['bash', 'scripts/check-anti-leak.sh'], cwd=self.root,
                              text=True, capture_output=True)

    def test_rejects_every_pattern_even_in_formerly_excluded_files(self):
        fixtures = [b'192.' + b'168.9.8', b'/opt/' + b'data/private',
                    b'/mn' + b't/storage', b'ptichalouf' + b'.xyz',
                    b'board' + b'-token']
        for path in ['README.md', 'docs/export-pipeline.md',
                     'deploy/tests/test_deploy.py', 'scripts/check-anti-leak.sh']:
            for fixture in fixtures:
                with self.subTest(path=path, fixture=fixture):
                    # Keep the launcher executable when testing its own path.
                    data = SCRIPT.read_bytes() + b'\n# ' + fixture if path.endswith('.sh') else fixture
                    result = self.scan(path, data)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn(path, result.stdout + result.stderr)
                    (self.root / path).unlink()
                    shutil.copy(SCRIPT, self.root / 'scripts/check-anti-leak.sh')

    def test_clean_examples_pass(self):
        result = self.scan('README.md', b'http://localhost:20128\n/var/lib/paperclip\nPAPERCLIP_API_KEY\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_binary_is_not_an_escape(self):
        result = self.scan('sample.bin', b'\x00\xff/opt/' + b'data/private')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('sample.bin', result.stdout + result.stderr)

    def test_git_failure_is_not_success(self):
        shutil.rmtree(self.root / '.git')
        result = subprocess.run(['bash', 'scripts/check-anti-leak.sh'], cwd=self.root,
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
