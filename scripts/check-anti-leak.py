#!/usr/bin/env python3
"""Scan every tracked file (including binary data); no path exclusions.

Synthetic regression payloads are assembled at runtime, not allowlisted.
Fragments below keep the scanner's own source free of sensitive literals.
This guard checks known infrastructure markers, not arbitrary credentials.
"""
import pathlib
import subprocess
import sys

PATTERNS = (
    b'192.' + b'168.', b'/opt/' + b'data', b'/mn' + b't/',
    b'ptichalouf' + b'.xyz', b'board' + b'-token',
)


def main():
    root = pathlib.Path(subprocess.check_output(
        ['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\0')
    failures = 0
    for raw in filter(None, files):
        path = raw.decode('utf-8', errors='surrogateescape')
        # Read a tracked symlink's target text, never follow it outside the tree.
        file = root / path
        data = str(file.readlink()).encode() if file.is_symlink() else file.read_bytes()
        for number, line in enumerate(data.splitlines(), 1):
            if any(pattern in line.lower() for pattern in PATTERNS):
                # Never echo a potentially secret line in a public CI log.
                print(f'{path}:{number}: forbidden infrastructure marker')
                failures += 1
    print(f'Anti-leak: {failures} offending lines; no exclusions')
    return int(failures > 0)


if __name__ == '__main__':
    sys.exit(main())
