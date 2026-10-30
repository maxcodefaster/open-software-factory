"""Runs inside the exact worker image, without privileges, source or network."""
import json
import os
from pathlib import Path
import signal
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


STORE = "1234567890abcdef1234567890abcdef"
POD = "owned-capacity-pod"
GIB = 1024 ** 3


class StorageAdmission(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.root.chmod(0o700)
        self.receipt = self.root / ".factory-initialized.json"
        self.receipt.write_text(json.dumps({"version": 1, "podUID": POD, "storeID": STORE}))
        self.receipt.chmod(0o600)
        self.messages = []

    def admit(self, **kwargs):
        return admit_capacity(self.root, POD, STORE, 8 * GIB,
                              observe=self.messages.append, **kwargs)

    def test_real_insufficient_filesystem_fails_without_waiting(self):
        # /tmp is an owned 64-MiB tmpfs in this proof. No synthetic free-space
        # observation can turn the actual insufficient-storage case green.
        original = signal.signal(signal.SIGALRM, lambda *_: self.fail("Capacity admission waited"))
        signal.alarm(2)
        try:
            with self.assertRaisesRegex(RuntimeError, "insufficient.*storage"):
                self.admit()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, original)
        self.assertEqual(len(self.messages), 1)
        observed = json.loads(self.messages[0])
        self.assertEqual(observed["state"], "insufficient-storage")
        self.assertLess(observed["availableBytes"], observed["requiredBytes"])
        self.assertFalse((self.root / "fixed-store").exists())

    def test_exact_capacity_boundary(self):
        for available in (20 * GIB - 1, 20 * GIB, 20 * GIB + 1):
            with self.subTest(available=available), patch(
                "os.fstatvfs", return_value=SimpleNamespace(
                    f_bavail=available, f_blocks=available, f_frsize=1, f_bsize=1)):
                self.messages.clear()
                if available < 20 * GIB:
                    with self.assertRaisesRegex(RuntimeError, "insufficient.*storage"):
                        self.admit()
                else:
                    self.assertEqual(self.admit()["state"], "ready")
                self.assertEqual(len(self.messages), 1)

    def test_foreign_pod_or_store_and_receipt_permissions_refuse(self):
        for field in ("podUID", "storeID"):
            self.receipt.write_text(json.dumps({
                "version": 1, "podUID": POD, "storeID": STORE, field: "foreign"}))
            with self.assertRaisesRegex(ValueError, "another original Pod or store"):
                self.admit()
        self.receipt.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "receipt is foreign"):
            self.admit()

    def test_existing_native_storage_and_symlinks_refuse(self):
        native = self.root / "fixed-store"
        native.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.admit()
        native.rmdir()
        self.receipt.unlink()
        self.receipt.symlink_to("/etc/passwd")
        with self.assertRaises(OSError):
            self.admit()

    def test_unavailable_capacity_refuses(self):
        with patch("os.fstatvfs", return_value=SimpleNamespace(
                f_bavail=2, f_blocks=1, f_frsize=4096, f_bsize=4096)):
            with self.assertRaisesRegex(ValueError, "capacity is unavailable"):
                self.admit()

    def test_invalid_profiles_refuse(self):
        for capacity in (0, 7 * GIB, 8 * GIB + 1, 33 * GIB, True):
            with self.subTest(capacity=capacity), self.assertRaises(ValueError):
                required_capacity(capacity)


unittest.main()
