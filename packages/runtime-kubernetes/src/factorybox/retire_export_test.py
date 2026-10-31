import hashlib
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
import shutil


class ExportRetirementTests(unittest.TestCase):
    def setUp(self):
        self.module = runpy.run_path(str(Path(__file__).with_name('retire-export.py')), run_name='owned_export_test')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.image = 'registry.invalid/runtime@sha256:'+'1'*64
        self.key = hashlib.sha256(self.image.encode()).hexdigest()
        self.request = {
            'version': 1, 'storeID': 'a'*32, 'epoch': 'b'*32, 'podUID': 'current-pod',
            'admissionID': 'c'*32, 'previous': {
                'admissionID': 'd'*32, 'podUID': 'original-pod', 'epoch': 'e'*32,
                'image': self.image, 'seedNamespace': None,
                'terminal': {'podUID': 'original-pod', 'phase': 'Succeeded'},
            },
        }
        self.status = {'store_id': 'a'*32, 'epoch': 'b'*32}
        self.environment = {'FACTORY_STORE_ID': 'a'*32, 'FACTORY_POD_UID': 'current-pod',
                            'FACTORY_SEED_NAMESPACE': 'c'*32}
        self.bootstrap = self.export(self.root/'seed')
        self.consumer = self.export(self.root/'consumer-seeds'/self.key, consumer=True)
        self.native = self.root/'fixed-store'
        self.native.mkdir()
        (self.native/'retained-state').write_bytes(b'preserve native snapshots and Source')
        current = self.root/'seeds'/('c'*32)/'bootstrap'
        self.current = self.export(current, pod='current-pod')
        self.metadata = {path: path.read_bytes() for path in self.root.rglob('*')
                         if path.is_file() and path.name != 'rootfs.tar'}

    def export(self, directory, pod='original-pod', consumer=False):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for parent in directory.parents:
            if parent == self.root.parent:
                break
            parent.chmod(0o700)
        data = b'owned-immutable-image-transport'
        digest = hashlib.sha256(data).hexdigest()
        files = {
            'intent': '\n'.join([pod, 'a'*32, self.image])+'\n',
            'rootfs.sha256': digest+'  rootfs.tar\n',
        }
        if consumer:
            plan = {'version': 1, 'storeID': 'a'*32, 'epoch': 'e'*32, 'podUID': pod,
                    'image': self.image, 'exporterName': 'consumer-'+self.key[:48]}
            files['intent.json'] = json.dumps(plan)
            files['complete.json'] = json.dumps({'intent': plan, 'exporterUID': 'exporter', 'rootfsSHA256': digest})
            files['exporter-uid'] = 'exporter'
        for name, value in files.items():
            path = directory/name
            path.write_text(value)
            path.chmod(0o600)
        archive = directory/'rootfs.tar'
        archive.write_bytes(data)
        archive.chmod(0o600)
        return archive

    def retire(self):
        return self.module['retire_exports'](self.root, self.request, self.status, self.environment)

    def test_completed_retired_exports_release_only_transport_payload_and_keep_receipts(self):
        result = self.retire()
        self.assertEqual(len(result['retired']), 2)
        self.assertFalse(self.bootstrap.exists())
        self.assertFalse(self.consumer.exists())
        self.assertTrue(self.current.exists())
        for path, content in self.metadata.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(len(self.retire()['retired']), 2)

    def test_active_or_unconfirmed_worker_is_never_an_archive_retirement_owner(self):
        for change in [
                {'podUID': 'current-pod'}, {'epoch': 'b'*32},
                {'terminal': {'podUID': 'original-pod', 'phase': 'Running'}}]:
            with self.subTest(change=change):
                original = self.request['previous']
                self.request['previous'] = {**original, **change}
                with self.assertRaises(ValueError):
                    self.retire()
                self.request['previous'] = original
        self.assertTrue(self.bootstrap.exists())
        self.assertTrue(self.consumer.exists())

    def test_partial_or_foreign_exports_stay_retained(self):
        (self.consumer.parent/'complete.json').unlink()
        (self.bootstrap.parent/'intent').write_text('foreign\n')
        result = self.retire()
        self.assertEqual(result['retired'], [])
        self.assertTrue(self.bootstrap.exists())
        self.assertTrue(self.consumer.exists())

    def test_changed_archive_is_not_deleted(self):
        self.bootstrap.write_bytes(b'changed content')
        result = self.retire()
        self.assertTrue(self.bootstrap.exists())
        self.assertEqual(len(result['retired']), 1)

    def test_interrupted_unlink_finishes_the_same_receipt_but_preserves_a_replacement(self):
        self.retire()
        complete = self.bootstrap.parent/'archive-retired.json'
        complete.unlink()
        self.assertEqual(len(self.retire()['retired']), 2)
        self.bootstrap.write_bytes(b'unexpected successor')
        self.bootstrap.chmod(0o600)
        self.retire()
        self.assertEqual(self.bootstrap.read_bytes(), b'unexpected successor')

    def test_scoped_previous_admission_never_retargets_legacy_or_current_exports(self):
        namespace = self.request['previous']['admissionID']
        self.request['previous']['seedNamespace'] = namespace
        parent = self.root/'seeds'/namespace
        parent.mkdir(mode=0o700)
        shutil.move(str(self.bootstrap.parent), parent/'bootstrap')
        consumers = self.root/'consumer-seeds'/namespace
        consumers.mkdir(mode=0o700)
        shutil.move(str(self.consumer.parent), consumers/self.key)
        scoped = consumers/self.key
        plan = json.loads((scoped/'intent.json').read_text())
        plan['exporterName'] = 'consumer-'+hashlib.sha256((namespace+':'+self.image).encode()).hexdigest()[:48]
        (scoped/'intent.json').write_text(json.dumps(plan))
        complete = json.loads((scoped/'complete.json').read_text())
        complete['intent'] = plan
        (scoped/'complete.json').write_text(json.dumps(complete))
        self.assertEqual(len(self.retire()['retired']), 2)
        self.assertTrue(self.current.exists())
        self.assertFalse((parent/'bootstrap/rootfs.tar').exists())
        self.assertFalse((scoped/'rootfs.tar').exists())

    def test_links_and_corrupt_retirement_metadata_never_authorize_unlink(self):
        link = self.root/'retained-link'
        os.link(self.bootstrap, link)
        self.retire()
        self.assertTrue(self.bootstrap.exists())
        self.assertTrue(link.exists())
        link.unlink()
        (self.bootstrap.parent/'archive-retirement.json').write_text('[]')
        (self.bootstrap.parent/'archive-retirement.json').chmod(0o600)
        self.retire()
        self.assertTrue(self.bootstrap.exists())


if __name__ == '__main__':
    unittest.main()
