"""Export intent and recovery tests. No Kubernetes or native mutations."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.module = runpy.run_path(sys.argv[1], run_name="consumer_test")
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()/'exports'
        image = 'registry.invalid/runtime@sha256:'+'a'*64
        self.key = hashlib.sha256(image.encode()).hexdigest()
        self.intent = {'version': 1, 'storeID': 'b'*32, 'epoch': 'c'*32,
                       'podUID': 'original-worker', 'image': image,
                       'exporterName': 'consumer-'+self.key[:48]}
        self.status = {'store_id': self.intent['storeID'], 'epoch': self.intent['epoch']}
        for context in [
                patch.dict(self.module['export'].__globals__, {'ROOT': self.root}),
                patch.dict(os.environ, {'FACTORY_STORE_ID': self.intent['storeID'],
                                        'FACTORY_POD_UID': self.intent['podUID']}),
                patch('subprocess.check_output', side_effect=lambda *a, **k: json.dumps(self.status).encode())]:
            context.start()
            self.addCleanup(context.stop)

    def command(self, action, **extra):
        return self.module['export']({'intent': self.intent, 'action': action, **extra})

    def complete(self):
        root = self.root/self.key
        (root/'exporter-uid').write_text('exporter')
        (root/'intent').write_text('\n'.join(self.intent[key] for key in ['podUID', 'storeID', 'image'])+'\n')
        (root/'rootfs.tar').write_bytes(b'exact-image')
        sha = hashlib.sha256(b'exact-image').hexdigest()
        (root/'rootfs.sha256').write_text(sha+'  rootfs.tar\n')
        return self.command('complete', exporterUID='exporter')

    def test_create_intent_is_durable_and_only_one_attempt_is_admitted(self):
        self.assertTrue(self.command('begin', existingUID=None)['create'])
        self.assertEqual(json.loads((self.root/self.key/'attempted.json').read_text()), self.intent)
        self.assertFalse(self.command('begin', existingUID=None)['create'])
        self.command('observe', exporterUID='exporter')
        with self.assertRaisesRegex(ValueError, 'UID changed'):
            self.command('observe', exporterUID='replacement')
        self.assertTrue(self.complete()['complete'])
        self.assertTrue(self.command('begin', existingUID=None)['complete'])

    def test_preexisting_exporter_is_not_adopted_without_intent(self):
        with self.assertRaisesRegex(ValueError, 'persisted original intent'):
            self.command('begin', existingUID='foreign')
        self.assertFalse((self.root/self.key).exists())

    def test_lost_or_partial_metadata_never_reauthorizes_create(self):
        self.command('begin', existingUID=None)
        (self.root/self.key/'attempted.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.command('begin', existingUID=None)
        (self.root/self.key/'intent.json').write_text('{"foreign":true}')
        with self.assertRaisesRegex(ValueError, 'another image'):
            self.command('begin', existingUID=None)

    def test_corrupt_export_cannot_publish_completion(self):
        self.command('begin', existingUID=None)
        self.complete()
        root = self.root/self.key
        (root/'complete.json').unlink()
        (root/'rootfs.tar').write_bytes(b'changed-image')
        with self.assertRaisesRegex(ValueError, 'committed export'):
            self.command('complete', exporterUID='exporter')
        self.assertFalse((root/'complete.json').exists())

    def test_worker_epoch_and_aliased_export_directory_fail_closed(self):
        self.status['epoch'] = 'f'*32
        with self.assertRaisesRegex(ValueError, 'epoch changed'):
            self.command('begin', existingUID=None)
        self.assertFalse(self.root.exists())
        self.status['epoch'] = self.intent['epoch']
        self.root.mkdir(mode=0o700)
        target = self.root/'foreign'
        target.mkdir(mode=0o700)
        (self.root/self.key).symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'directory identity'):
            self.command('begin', existingUID=None)
        self.assertEqual(list(target.iterdir()), [])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
