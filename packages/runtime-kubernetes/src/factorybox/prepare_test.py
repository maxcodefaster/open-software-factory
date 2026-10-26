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
            "version": 3, "sandboxID": "runtime-" + "a" * 32,
            "storeID": "b" * 32, "epoch": "c" * 32, "podUID": "pod",
            "runtimeHostImage": "registry.invalid/runtime@sha256:" + "d" * 64,
            "sharedSource": False, "sourceWorkspaceID": None, "reserveSeed": False, "bootstrap": ":",
        }

    def assigned(self, **changes):
        request = {**self.request, **changes}
        return {**request, "assignment": {
            "assignment.json": json.dumps({"version": 1, "runtimeAttemptId": request["sandboxID"][8:],
                                           "generation": 1}),
            "parent-token": "only-this-parent", "child-token": "only-this-child",
        }}

    def environment(self):
        return patch.dict(os.environ, {"FACTORY_POD_UID": self.request["podUID"],
                                       "FACTORY_STORE_ID": self.request["storeID"]})

    def test_old_single_sandbox_protocol_is_refused_before_worker_commands(self):
        request = {**self.request, "version": 1, "sharedSource": False, "bootstrap": ":"}
        del request["sandboxID"]
        with patch("subprocess.check_output") as command:
            with self.assertRaisesRegex(ValueError, "Unexpected Factory preparation fields"):
                self.module["prepare"](request)
            command.assert_not_called()

    def test_cached_preparation_cannot_substitute_another_sandbox_receipt(self):
        request = self.assigned()
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        root = self.root / "input" / request["sandboxID"]
        (root / "bundle").mkdir(parents=True)
        (root / "intent.json").write_text(json.dumps({"request": request, "rootfsSHA256": rootfs, "source": None}))
        (root / "prepared.json").write_text(json.dumps({
            "version": 3, "sandboxID": "runtime-" + "e" * 32,
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
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"],
                  "lifecycle": {"root": str(controller)}}
        commands = []

        def unmount(args, **kwargs):
            commands.append(args)
            del mounts[args[-1]]

        # runpy functions retain their own global namespace.
        globals_ = self.module["release"].__globals__
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()) as reads, \
                patch("subprocess.run", side_effect=unmount), \
                self.environment(), \
                patch.dict(globals_, {
                    "prepared_input": lambda value, status: {
                        "bundle": str(bundle), "storeID": request["storeID"], "epoch": request["epoch"]},
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
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"],
                  "lifecycle": {"root": str(self.root / "controller")}}
        replies = [json.dumps(status).encode(),
                   json.dumps({"record": {"id": "runtime-" + "e" * 32, "phase": "deleted"}}).encode()]
        globals_ = self.module["release"].__globals__
        with patch("subprocess.check_output", side_effect=replies), \
                patch("subprocess.run") as mutation, \
                self.environment(), \
                patch.dict(globals_, {"prepared_input": lambda value, status: {
                    "bundle": str(root / "bundle"), "storeID": request["storeID"], "epoch": request["epoch"]}}):
            with self.assertRaisesRegex(ValueError, "confirmed native Delete"):
                self.module["release"](request, False)
            mutation.assert_not_called()

    def test_ambient_assignment_protocol_is_refused_before_worker_commands(self):
        request = {**self.request, "version": 2}
        del request["sourceWorkspaceID"]
        with patch("subprocess.check_output") as command:
            with self.assertRaisesRegex(ValueError, "Unexpected Factory preparation fields"):
                self.module["prepare"](request)
            command.assert_not_called()

    def test_only_exact_per_sandbox_files_and_assignment_owners_are_accepted(self):
        request = self.assigned()
        self.module["validate_assignment"](request)
        for change in [
            {"assignment": {**request["assignment"], "../another": "no"}},
            {"assignment": {"slot.json": "{}"}},
            {"assignment": {**request["assignment"], "parent-token": ""}},
            {"assignment": {**request["assignment"], "parent-token": "\0"}},
            {"assignment": {**request["assignment"], "assignment.json":
                json.dumps({"version": 1, "runtimeAttemptId": "e" * 32, "generation": 1})}},
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.module["validate_assignment"]({**request, **change})
        reserve = {**self.request, "reserveSeed": True,
                   "assignment": {"slot.json": json.dumps({"version": 1, "id": "a" * 32})}}
        self.module["validate_assignment"](reserve)
        with self.assertRaisesRegex(ValueError, "undeclared"):
            self.module["validate_assignment"]({
                **reserve, "assignment": {**reserve["assignment"], "parent-token": "must-not-enter-seed"}})

    def test_source_bindings_have_independent_workspace_paths_and_inode_identities(self):
        source = self.root / "sources"
        for key in ["a" * 32, "e" * 32]:
            (source / "workspaces" / key / "home/project").mkdir(parents=True)
        globals_ = self.module["canonical_source"].__globals__
        with patch.dict(globals_, {"SOURCE_ROOT": source, "SOURCE_USER": (os.getuid(), os.getgid())}):
            first = self.module["canonical_source"]({
                **self.request, "sharedSource": True, "sourceWorkspaceID": "a" * 32})
            second = self.module["canonical_source"]({
                **self.request, "sharedSource": True, "sourceWorkspaceID": "e" * 32})
            self.assertNotEqual(first["path"], second["path"])
            self.assertNotEqual(first["inode"], second["inode"])
            self.assertEqual(first["workspaceID"], "a" * 32)
            with self.assertRaisesRegex(ValueError, "exact Workspace"):
                self.module["canonical_source"]({
                    **self.request, "sharedSource": True, "sourceWorkspaceID": "../other"})
        with patch.dict(globals_, {"SOURCE_ROOT": source, "SOURCE_USER": (os.getuid() + 1, os.getgid())}):
            with self.assertRaisesRegex(ValueError, "Source service identity"):
                self.module["canonical_source"]({
                    **self.request, "sharedSource": True, "sourceWorkspaceID": "a" * 32})

    def test_source_aliases_are_refused_at_every_ancestor_and_at_the_workspace_root(self):
        for index in range(5):
            with self.subTest(component=index):
                source = self.root / str(index)
                project = source / "workspaces" / ("a" * 32) / "home/project"
                project.mkdir(parents=True)
                paths = [source, source / "workspaces", project.parent.parent, project.parent, project]
                original = paths[index]
                saved = original.with_name(original.name + "-saved")
                original.rename(saved)
                original.symlink_to(saved, target_is_directory=True)
                globals_ = self.module["canonical_source"].__globals__
                with patch.dict(globals_, {"SOURCE_ROOT": source, "SOURCE_USER": (os.getuid(), os.getgid())}):
                    with self.assertRaisesRegex(ValueError, "missing or aliased"):
                        self.module["canonical_source"]({
                            **self.request, "sharedSource": True, "sourceWorkspaceID": "a" * 32})

    def test_cached_preparation_refuses_a_replaced_canonical_source_directory(self):
        source = self.root / "sources"
        project = source / "workspaces" / ("a" * 32) / "home/project"
        project.mkdir(parents=True)
        request = self.assigned(sharedSource=True, sourceWorkspaceID="a" * 32)
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        root = self.root / "input" / request["sandboxID"]
        root.mkdir(parents=True)
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"]}
        globals_ = self.module["prepare"].__globals__
        with patch.dict(globals_, {"SOURCE_ROOT": source, "SOURCE_USER": (os.getuid(), os.getgid())}):
            bound = self.module["canonical_source"](request)
            (root / "intent.json").write_text(json.dumps({
                "request": request, "rootfsSHA256": rootfs, "source": bound}))
            project.rename(project.with_name("retained-original"))
            project.mkdir()
            with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                    patch("subprocess.run") as mutation, self.environment(), \
                    patch.dict(globals_, {"Path": lambda path:
                        seed if str(path) == "/var/lib/sysbox/seed" else Path(path)}):
                with self.assertRaisesRegex(ValueError, "another preparation"):
                    self.module["prepare"](request)
                mutation.assert_not_called()


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PreparationTests)
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not outcome.wasSuccessful())
