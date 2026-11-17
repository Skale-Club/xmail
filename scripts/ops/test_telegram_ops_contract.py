"""An old panel/cache must never override an explicitly configured ops bot."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class OpsResolverTests(unittest.TestCase):
    def test_dedicated_pair_wins_and_partial_pair_fails_closed(self):
        bash = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash')
        def posix(path):
            value = str(path).replace('\\', '/')
            return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value
        script = Path(__file__).resolve().parents[1] / 'resolve-alert-credentials.sh'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'cache'
            cache.write_text('TELEGRAM_BOT_TOKEN=123:old\nTELEGRAM_CHAT_ID=-123\n', encoding='utf-8')
            curl = root / 'curl'
            curl.write_text('#!/usr/bin/env bash\ntouch "$CURL_CALLED"\nexit 99\n', encoding='utf-8')
            curl.chmod(0o755)
            for chat in ('-1004421256889', ''):
                output = root / 'environment'
                result = root / 'result'
                output.write_text(''); result.write_text('')
                env = dict(os.environ, OPS_TELEGRAM_BOT_TOKEN='456:central', OPS_TELEGRAM_CHAT_ID=chat,
                           OPS_TELEGRAM_THREAD_ID='', CACHE_FILE=posix(cache), GITHUB_ENV=posix(output),
                           GITHUB_OUTPUT=posix(result), MOCK_BIN=posix(root), TARGET=posix(script),
                           APP_URL='https://offline.invalid', MONITOR_API_TOKEN='fixture',
                           CURL_CALLED=posix(root / 'curl-called'))
                run = subprocess.run([bash, '-c', 'PATH="$MOCK_BIN:$PATH" bash "$TARGET"'], env=env, capture_output=True, timeout=15)
                self.assertEqual(run.returncode, 0)
                self.assertFalse((root / 'curl-called').exists())
                actual = dict(line.split('=', 1) for line in output.read_text().splitlines())
                self.assertEqual(actual['TELEGRAM_BOT_TOKEN'], '456:central' if chat else '')
                self.assertEqual(actual['TELEGRAM_CHAT_ID'], chat)
                self.assertNotIn('123:old', output.read_text())
                self.assertIn('ops-secrets' if chat else 'incomplete-ops', result.read_text())


if __name__ == '__main__':
    unittest.main()
