import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import fcntl


class RetainedStoreTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('inspect_store', Path(__file__).with_name('inspect-store.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        bounded = self.root/'fixed-store'
        bounded.mkdir(mode=0o700)
        self.image = bounded/'store.img'
        self.image.write_bytes(b'preserved-image'+bytes(4096-15))
        self.image.chmod(0o600)
        self.image_info = self.image.stat()
        self.receipt = self.root/'.factory-initialized.json'
        self.receipt.write_text(json.dumps({'version': 1, 'podUID': 'original', 'storeID': 'a'*32}))
        self.receipt.chmod(0o600)
        self.record = bounded/'bounded.json'
        self.record.write_text(json.dumps({'schema': 1, 'image': {
            'schema': 1, 'owner': 'a'*32, 'bytes': self.image_info.st_size,
            'device': self.image_info.st_dev, 'inode': self.image_info.st_ino,
            'path': '/var/lib/sysbox/fixed-store/store.img'}}))
        self.record.chmod(0o600)
        self.lock = bounded/'.worker.lock'
        self.lock.touch(mode=0o600)
        original = Path.lstat
        def observed(path):
            info = list(original(path))
            info[4], info[5] = 0, 0
            return os.stat_result(info)
        context = patch.object(Path, 'lstat', observed)
        context.start()
        self.addCleanup(context.stop)

    def inspect(self):
        return self.module.inspect(self.root, 'original', 'a'*32, self.image_info.st_size)

    def test_exact_retained_store_is_only_read_and_never_initialized_again(self):
        before = {path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                  for path in [self.receipt, self.record, self.image, self.lock]}
        self.assertEqual(self.inspect()['storeID'], 'a'*32)
        self.assertEqual({path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                          for path in before}, before)
        self.assertEqual(self.image.stat().st_ino, self.image_info.st_ino)

    def test_live_original_store_lease_refuses_successor(self):
        with self.lock.open('r') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.inspect()

    def test_missing_image_is_not_recreated(self):
        self.image.unlink()
        with self.assertRaises(FileNotFoundError):
            self.inspect()
        self.assertFalse(self.image.exists())
        self.assertTrue(self.record.exists())

    def test_changed_capacity_and_original_pod_fail_without_repair(self):
        with self.assertRaisesRegex(ValueError, 'capacity changed'):
            self.module.inspect(self.root, 'original', 'a'*32, self.image_info.st_size+1)
        with self.assertRaisesRegex(ValueError, 'original Pod'):
            self.module.inspect(self.root, 'replacement', 'a'*32, self.image_info.st_size)
        self.root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'directory identity'):
            self.inspect()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o755)


if __name__ == '__main__':
    unittest.main()
