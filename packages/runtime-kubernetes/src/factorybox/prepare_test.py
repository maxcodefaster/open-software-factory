"""Preparation ownership controls, executed by the native consumer fixture."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.module = runpy.run_path(sys.argv[1], run_name="factory_preparation_probe")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.request = {
            "version": 2, "sandboxID": "runtime-" + "a" * 32,
            "storeID": "b" * 32, "epoch": "c" * 32, "podUID": "pod",
            "runtimeHostImage": "registry.invalid/runtime@sha256:" + "d" * 64,
        }

    def test_old_single_sandbox_protocol_is_refused_before_worker_commands(self):
        request = {**self.request, "version": 1, "sharedSource": False, "bootstrap": ":"}
        del request["sandboxID"]
        with patch("subprocess.check_output") as command:
            with self.assertRaisesRegex(ValueError, "Unexpected Factory preparation fields"):
                self.module["prepare"](request)
            command.assert_not_called()

    def test_cached_preparation_cannot_substitute_another_sandbox_receipt(self):
        request = {**self.request, "sharedSource": False, "reserveSeed": False, "bootstrap": ":"}
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        root = self.root / "input" / request["sandboxID"]
        (root / "bundle").mkdir(parents=True)
        (root / "intent.json").write_text(json.dumps({"request": request, "rootfsSHA256": rootfs}))
        (root / "prepared.json").write_text(json.dumps({
            "version": 2, "sandboxID": "runtime-" + "e" * 32,
            "bundle": str(root / "bundle"), "storeID": request["storeID"],
            "epoch": request["epoch"], "podUID": request["podUID"], "rootfsSHA256": rootfs,
        }))
        globals_ = self.module["prepare"].__globals__
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"]}
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, \
                patch.dict(os.environ, {"FACTORY_POD_UID": request["podUID"],
                                        "FACTORY_STORE_ID": request["storeID"]}), \
                patch.dict(globals_, {"Path": lambda path: seed if str(path) == "/var/lib/sysbox/seed" else Path(path)}):
            with self.assertRaisesRegex(ValueError, "Prepared OCI configuration changed"):
                self.module["prepare"](request)
            mutation.assert_not_called()

    def test_one_image_source_is_reused_across_distinct_sandbox_preparations(self):
        seed = self.root / "seed"
        seed.mkdir()
        with tarfile.open(seed / "rootfs.tar", "w") as archive:
            for name in ["home", "home/coder", "home/coder/project"]:
                info = tarfile.TarInfo(name)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)
        digest = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        imported = []

        def unpack(args, **kwargs):
            with tarfile.open(seed / "rootfs.tar") as archive:
                archive.extractall(args[args.index("-C") + 1], filter="data")

        def base(args, **kwargs):
            imported.append(args[args.index("--source") + 1])
            return json.dumps({"tree": {"saved": "/owned/base"}}).encode()

        with patch("subprocess.run", side_effect=unpack) as extraction, \
                patch("subprocess.check_output", side_effect=base):
            self.module["image_base"](self.request, {"store": str(self.root)}, seed, digest, ["cli"])
            sibling = {**self.request, "sandboxID": "runtime-" + "e" * 32}
            self.module["image_base"](sibling, {"store": str(self.root)}, seed, digest, ["cli"])
            self.assertEqual(extraction.call_count, 1)
            self.assertEqual(imported[0], imported[1])
            self.assertFalse((Path(imported[0]) / "home/coder/project").exists())
            with self.assertRaisesRegex(ValueError, "another identity"):
                self.module["image_base"](
                    {**sibling, "runtimeHostImage": "foreign"}, {"store": str(self.root)}, seed, digest, ["cli"])
            self.assertEqual(extraction.call_count, 1)

    def test_unused_sibling_release_does_not_inspect_or_unmount_the_running_object(self):
        request = self.request
        root = self.root / "input" / request["sandboxID"]
        root.mkdir(parents=True)
        (root / "prepared.json").write_text("{}")
        bundle = root / "bundle"
        bundle.mkdir()
        mounts = {str(bundle / name): {"mountinfo": name} for name in ["rootfs", "lower"]}
        (root / "mounts.json").write_text(json.dumps(mounts))
        controller = self.root / "controller"
        running = controller / "objects" / ("runtime-" + "e" * 32)
        running.mkdir(parents=True)
        status = {"store": str(self.root), "lifecycle": {"root": str(controller)}}
        commands = []

        def unmount(args, **kwargs):
            commands.append(args)
            del mounts[args[-1]]

        # runpy functions retain their own global namespace.
        globals_ = self.module["release"].__globals__
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()) as reads, \
                patch("subprocess.run", side_effect=unmount), \
                patch.dict(globals_, {
                    "prepare": lambda value: {"bundle": str(bundle), "storeID": request["storeID"],
                                              "epoch": request["epoch"]},
                    "input_mounts": lambda value: dict(mounts),
                }):
            self.assertTrue(self.module["release"](request, True)["released"])
            self.assertEqual(reads.call_count, 1)  # Worker status only, no sibling state.
            self.assertEqual(commands, [["umount", "--", str(bundle / name)] for name in ["rootfs", "lower"]])
            self.assertTrue(running.is_dir())

    def test_another_sandbox_deleted_record_cannot_authorize_release(self):
        request = self.request
        root = self.root / "input" / request["sandboxID"]
        root.mkdir(parents=True)
        (root / "prepared.json").write_text("{}")
        status = {"store": str(self.root), "lifecycle": {"root": str(self.root / "controller")}}
        replies = [json.dumps(status).encode(),
                   json.dumps({"record": {"id": "runtime-" + "e" * 32, "phase": "deleted"}}).encode()]
        globals_ = self.module["release"].__globals__
        with patch("subprocess.check_output", side_effect=replies), \
                patch("subprocess.run") as mutation, \
                patch.dict(globals_, {"prepare": lambda value: {
                    "bundle": str(root / "bundle"), "storeID": request["storeID"], "epoch": request["epoch"]}}):
            with self.assertRaisesRegex(ValueError, "confirmed native Delete"):
                self.module["release"](request, False)
            mutation.assert_not_called()


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PreparationTests)
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not outcome.wasSuccessful())
