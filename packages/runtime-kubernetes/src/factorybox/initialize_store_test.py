import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest


class StoreInitializationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('store_initializer', Path(__file__).with_name('initialize-store.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def initialize(self, pod='original'):
        # Native container execution has UID/GID 0. Portable tests preserve the
        # same ownership check using this process's original temporary root.
        original = Path.lstat
        def observed(path):
            info = original(path)
            values = list(info)
            values[4], values[5] = 0, 0
            return os.stat_result(values)
        from unittest.mock import patch
        with patch.object(Path, 'lstat', observed):
            return self.module.initialize(self.root, pod, 'a'*32)

    def test_only_empty_original_volume_is_initialized_and_exact_replay_is_read_only(self):
        (self.root/'seed').mkdir()
        self.root.chmod(0o777)
        self.initialize()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        before = (self.root/'.factory-initialized.json').read_bytes()
        (self.root/'seed'/'rootfs.tar').write_bytes(b'preserve exported image')
        self.initialize()
        self.assertEqual((self.root/'.factory-initialized.json').read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'another original Pod'):
            self.initialize('replacement')
        self.assertEqual((self.root/'seed'/'rootfs.tar').read_bytes(), b'preserve exported image')

    def test_nonempty_and_aliased_volumes_are_refused_without_chmod_or_deletion(self):
        for name in ['fixed-store', 'unknown', 'seed']:
            with self.subTest(name=name):
                path = self.root/name
                path.mkdir()
                (path/'retained').write_bytes(b'preserve')
                self.root.chmod(0o777)
                with self.assertRaisesRegex(ValueError, 'untouched'):
                    self.initialize()
                self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o777)
                self.assertEqual((path/'retained').read_bytes(), b'preserve')
                (path/'retained').unlink()
                path.rmdir()
        target = self.root/'target'
        target.mkdir()
        (self.root/'seed').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'untouched'):
            self.initialize()


if __name__ == '__main__':
    unittest.main()
