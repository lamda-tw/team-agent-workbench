"""Exercise the real Python bootstrap, without making privileged OS changes."""
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import unittest
import zlib


ROOT = pathlib.Path(__file__).resolve().parents[1]


class AdminTransportTests(unittest.TestCase):
    def loader(self):
        connection = (ROOT / 'src/admin/connection.ts').read_text(encoding='utf-8')
        match = re.search(r"const program = `python3 -u -c '([^']+)'`;", connection)
        self.assertIsNotNone(match, 'test must execute the production SSH bootstrap')
        return match.group(1)

    def run_program(self, arguments, payload, encoding='ascii'):
        return subprocess.run(
            [sys.executable, '-u', *arguments], input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
            env={**os.environ, 'PYTHONIOENCODING': encoding, 'PYTHONUTF8': '0'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )

    def bundle(self, echo=False):
        acl = (ROOT / 'server/acl_support.py').read_text(encoding='utf-8')
        groups = (ROOT / 'server/group_ops.py').read_text(encoding='utf-8')
        program = (ROOT / 'server/admin.py').read_text(encoding='utf-8')
        if echo:
            # Replace only the privileged business operation, not the bootstrap
            # or JSON/stream handling that caused the real startup failure.
            self.assertEqual(program.count('result = main(request)'), 1)
            program = program.replace('result = main(request)', 'result = {"request": request}')
        return base64.b64encode(zlib.compress((acl + '\n' + groups + '\n' + program).encode('utf-8'))) + b'\n'

    def test_bundled_entry_reaches_request_validation_after_reading_code(self):
        # Invalid operation is rejected before any Linux/root/filesystem access.
        payload = self.bundle() + json.dumps({'op': 'unsupported', 'root': '/srv/teamspace'}).encode('utf-8') + b'\n'
        result = self.run_program(['-c', self.loader()], payload)
        lines = result.stdout.decode('utf-8').splitlines()
        self.assertEqual(lines[:2], ['WORKBENCH_CODE_READY', 'WORKBENCH_READY'], result.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(json.loads(lines[2]), {'ok': False, 'error': '不支持的管理操作'})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b'')

    def test_unicode_request_survives_code_and_json_arriving_in_one_pipe(self):
        request = {'op': 'storage_upgrade', 'root': '/srv/团队共享', 'name': '中文成员', 'password': '测试密码-仅在标准输入'}
        payload = self.bundle(echo=True) + json.dumps(request, ensure_ascii=False).encode('utf-8') + b'\n'
        for encoding in ['ascii', 'gbk', 'utf-8']:
            with self.subTest(encoding=encoding):
                result = self.run_program(['-c', self.loader()], payload, encoding)
                self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                lines = result.stdout.decode('utf-8').splitlines()
                self.assertEqual(lines[:2], ['WORKBENCH_CODE_READY', 'WORKBENCH_READY'])
                self.assertEqual(json.loads(lines[2]), {'ok': True, 'value': {'request': request}})
                self.assertEqual(result.stderr, b'')

    def test_standalone_script_still_returns_structured_utf8_errors(self):
        request = json.dumps({'op': '不支持的操作'}, ensure_ascii=False).encode('utf-8') + b'\n'
        result = self.run_program([str(ROOT / 'server/admin.py')], request)
        lines = result.stdout.decode('utf-8').splitlines()
        self.assertEqual(lines[0], 'WORKBENCH_READY')
        self.assertEqual(json.loads(lines[1]), {'ok': False, 'error': '不支持的管理操作'})
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
