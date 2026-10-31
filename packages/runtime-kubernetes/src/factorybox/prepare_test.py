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
        self.root = Path(self.temporary.name).resolve()
        self.request = {
            "version": 3, "sandboxID": "runtime-" + "a" * 32,
            "storeID": "b" * 32, "epoch": "c" * 32, "podUID": "pod",
            "runtimeHostImage": "registry.invalid/runtime@sha256:" + "d" * 64,
            "sharedSource": False, "sourceWorkspaceID": None, "reserveSeed": False, "bootstrap": ":",
        }
        environment = patch.dict(os.environ, {"FACTORY_RUNTIME_IMAGE": self.request["runtimeHostImage"]})
        environment.start()
        self.addCleanup(environment.stop)
        # Portable ownership cases use the original qualified 3-CPU budget.
        # PIDBudgetTests below exercise the actual Linux cgroup reader.
        budget = patch.dict(self.module["prepare"].__globals__, {"worker_pid_limit": lambda: 384})
        budget.start()
        self.addCleanup(budget.stop)

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

    def test_recovered_worker_bootstrap_and_consumers_use_only_its_admission_inputs(self):
        namespace = 'f'*32
        seed = self.module['consumer_seed']
        with patch.dict(os.environ, {'FACTORY_SEED_NAMESPACE': namespace}):
            self.assertEqual(seed(self.request), Path('/var/lib/sysbox/seeds')/namespace/'bootstrap')
            upgraded = {**self.request, 'runtimeHostImage': 'registry.invalid/next@sha256:'+'1'*64}
            key = hashlib.sha256(upgraded['runtimeHostImage'].encode()).hexdigest()
            self.assertEqual(seed(upgraded), Path('/var/lib/sysbox/consumer-seeds')/namespace/key)
        self.assertEqual(seed(self.request), Path('/var/lib/sysbox/seed'))

    def test_preparation_consumes_one_lifecycle_and_does_not_restart_expired_work(self):
        remaining = self.module["remaining_preparation_seconds"]
        deadline = self.module["PREPARATION_DEADLINE"]
        with patch("time.monotonic", return_value=deadline - 300):
            self.assertEqual(remaining(), 300)
        with patch("time.monotonic", return_value=deadline):
            with self.assertRaisesRegex(TimeoutError, "lifecycle deadline expired"):
                remaining()

    def test_failed_metadata_write_removes_only_its_own_new_partial_file(self):
        path = self.root / "owned-intent.json"
        with patch("json.dump", side_effect=OSError("owned disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.module["publish"](path, {"version": 1})
        self.assertFalse(path.exists())
        path.write_text("preserve existing metadata")
        with self.assertRaises(FileExistsError):
            self.module["publish"](path, {"version": 1})
        self.assertEqual(path.read_text(), "preserve existing metadata")

    def test_failed_metadata_write_preserves_a_replacement_at_the_same_path(self):
        path = self.root / "owned-intent.json"

        def replaced(*_, **__):
            path.unlink()
            path.write_text("preserve successor")
            raise OSError("owned interrupted metadata write")

        with patch("json.dump", side_effect=replaced):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.module["publish"](path, {"version": 1})
        self.assertEqual(path.read_text(), "preserve successor")

    def test_checkpoint_profile_denies_all_io_uring_entrypoints_on_each_native_architecture(self):
        for machine, architecture in [("aarch64", "SCMP_ARCH_AARCH64"),
                                       ("x86_64", "SCMP_ARCH_X86_64")]:
            with self.subTest(machine=machine):
                linux = {}
                self.module["checkpoint_io_policy"](linux, machine)
                self.assertEqual(linux["seccomp"], {
                    "defaultAction": "SCMP_ACT_ALLOW",
                    "architectures": [architecture],
                    "syscalls": [{"names": ["io_uring_setup", "io_uring_enter", "io_uring_register"],
                                  "action": "SCMP_ACT_ERRNO", "errnoRet": 1}],
                })

    def test_checkpoint_profile_never_replaces_unreviewed_seccomp_or_accepts_another_architecture(self):
        existing = {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []}
        linux = {"seccomp": existing}
        with self.assertRaisesRegex(ValueError, "existing seccomp"):
            self.module["checkpoint_io_policy"](linux, "aarch64")
        self.assertIs(linux["seccomp"], existing)
        unsupported = {}
        with self.assertRaisesRegex(ValueError, "architecture"):
            self.module["checkpoint_io_policy"](unsupported, "armv7l")
        self.assertEqual(unsupported, {})

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
        (root / "intent.json").write_text(json.dumps(self.module["preparation_plan"](request, rootfs, None)))
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

    def test_preparation_metadata_retains_assignment_hash_not_credentials(self):
        request = self.assigned()
        plan = self.module["preparation_plan"](request, "a" * 64, None)
        encoded = json.dumps(plan)
        for secret in request["assignment"].values():
            self.assertNotIn(secret, encoded)
        self.assertNotIn("assignment", plan["request"])
        self.assertEqual(len(plan["assignmentSHA256"]), 64)
        reordered = {**request, "assignment": dict(reversed(list(request["assignment"].items())))}
        self.assertEqual(plan, self.module["preparation_plan"](reordered, "a" * 64, None))
        changed = {**request, "assignment": {**request["assignment"], "parent-token": "another-parent"}}
        self.assertNotEqual(plan, self.module["preparation_plan"](changed, "a" * 64, None))

    def test_explicit_cancellation_fences_an_unpublished_preparation_without_replay(self):
        request = self.request
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"],
                  "lifecycle": {"root": str(self.root / "controller")}}
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, self.environment():
            result = self.module["cancel_preparation"](request)
            self.assertEqual(result, {"version": 1, "cancelled": True,
                                      "sandboxID": request["sandboxID"]})
            self.assertEqual(result, self.module["cancel_preparation"](request))
            root = self.root / "input" / request["sandboxID"]
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["intent.json"])
            self.assertNotIn("assignment", (root / "intent.json").read_text())
            with self.assertRaisesRegex(ValueError, "explicitly cancelled"):
                self.module["prepare"](self.assigned())
            mutation.assert_not_called()

    def test_cancellation_preserves_partial_inputs_and_native_objects(self):
        request = self.request
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"],
                  "lifecycle": {"root": str(self.root / "controller")}}
        root = self.root / "input" / request["sandboxID"]
        root.mkdir(parents=True)
        (root / "intent.json").write_text('{"foreign":"preserve partial input"}')
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, self.environment():
            with self.assertRaisesRegex(ValueError, "Incomplete preparation"):
                self.module["cancel_preparation"](request)
            self.assertEqual((root / "intent.json").read_text(),
                             '{"foreign":"preserve partial input"}')
            root.rename(root.parent / "retained-partial")
            native = self.root / "controller/objects" / request["sandboxID"]
            native.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, "native object"):
                self.module["cancel_preparation"](request)
            self.assertFalse(root.exists())
            mutation.assert_not_called()

    def test_cancellation_wins_a_prepare_racing_between_base_admission_and_input_creation(self):
        request = self.assigned()
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"],
                  "lifecycle": {"root": str(self.root / "controller")}}

        def admitted(*_):
            self.module["cancel_preparation"](self.request)
            return {"tree": {"saved": "/unused-independent-base"}}

        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, self.environment(), \
                patch.dict(self.module["prepare"].__globals__, {
                    "Path": lambda path: seed if str(path) == "/var/lib/sysbox/seed" else Path(path),
                    "image_base": admitted,
                }):
            with self.assertRaises(FileExistsError):
                self.module["prepare"](request)
            root = self.root / "input" / request["sandboxID"]
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["intent.json"])
            self.assertTrue(json.loads((root / "intent.json").read_text())["cancelled"])
            mutation.assert_not_called()

    def test_base_admission_refusal_does_not_poison_a_new_private_input(self):
        request = self.assigned()
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"]}
        root = self.root / "input" / request["sandboxID"]
        globals_ = self.module["prepare"].__globals__
        refusals = [RuntimeError("Native base admission is temporarily busy"),
                    RuntimeError("Retry reached the same immutable base admission")]
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, self.environment(), \
                patch.dict(globals_, {
                    "Path": lambda path: seed if str(path) == "/var/lib/sysbox/seed" else Path(path),
                    "image_base": unittest.mock.Mock(side_effect=refusals),
                }):
            with self.assertRaisesRegex(RuntimeError, "temporarily busy"):
                self.module["prepare"](request)
            self.assertFalse(root.exists(), "A refused shared base must not leave a partial private input")
            with self.assertRaisesRegex(RuntimeError, "same immutable base"):
                self.module["prepare"](request)
            self.assertFalse(root.exists())
            mutation.assert_not_called()

    def test_invalid_worker_budget_fails_before_native_base_or_private_input_mutation(self):
        request = self.assigned()
        seed = self.root / "seed"
        seed.mkdir()
        (seed / "rootfs.tar").write_bytes(b"exact frozen image")
        rootfs = hashlib.sha256((seed / "rootfs.tar").read_bytes()).hexdigest()
        (seed / "rootfs.sha256").write_text(rootfs + "  rootfs.tar\n")
        (seed / "intent").write_text(
            "\n".join(request[key] for key in ["podUID", "storeID", "runtimeHostImage"]) + "\n")
        status = {"store": str(self.root), "store_id": request["storeID"], "epoch": request["epoch"]}
        with patch("subprocess.check_output", return_value=json.dumps(status).encode()), \
                patch("subprocess.run") as mutation, self.environment(), \
                patch.dict(self.module["prepare"].__globals__, {
                    "Path": lambda path: seed if str(path) == "/var/lib/sysbox/seed" else Path(path),
                    "worker_pid_limit": unittest.mock.Mock(side_effect=ValueError("Invalid worker CPU ceiling")),
                    "image_base": unittest.mock.Mock(side_effect=AssertionError("Must not import a base")),
                }):
            with self.assertRaisesRegex(ValueError, "worker CPU ceiling"):
                self.module["prepare"](request)
            self.assertFalse((self.root / "input").exists())
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
        status = {"store": str(self.root), "boot_id": "owned-boot",
                  "lifecycle": {"root": str(self.root / "controller"),
                                "runtime_sha256": "e" * 64}}

        def unpack(args, **kwargs):
            self.assertGreater(kwargs["timeout"], 120,
                               "cold extraction must use its remaining lifecycle, not a 90-second cap")
            with tarfile.open(seed / "rootfs.tar") as archive:
                destination = Path(args[args.index("-C") + 1])
                for member in archive.getmembers():
                    self.assertTrue(member.isdir())
                    self.assertFalse(Path(member.name).is_absolute())
                    self.assertNotIn("..", Path(member.name).parts)
                    (destination / member.name).mkdir(parents=True, exist_ok=True)

        def base(args, **kwargs):
            self.assertGreater(kwargs["timeout"], 120,
                               "cold native import must use its remaining lifecycle, not a two-minute cap")
            source = args[args.index("--source") + 1]
            imported.append(source)
            saved = str(self.root / "controller/bases/factory-runtime/rootfs")
            return json.dumps({"version": 1, "id": "factory-runtime", "source": source,
                               "boot_id": "owned-boot", "runtime_sha256": "e" * 64,
                               "prepared_at": "owned-time",
                               "tree": {"source": source, "saved": saved, "sha256": "f" * 64,
                                        "immutable": {"root": saved}}}).encode()

        with patch("subprocess.run", side_effect=unpack) as extraction, \
                patch("subprocess.check_output", side_effect=base), \
                patch.dict(self.module["image_base"].__globals__, {"image_source_mounts": lambda _: False}):
            self.module["image_base"](self.request, status, seed, digest, ["cli"])
            sibling = {**self.request, "sandboxID": "runtime-" + "e" * 32}
            self.module["image_base"](sibling, status, seed, digest, ["cli"])
            self.assertEqual(extraction.call_count, 1)
            self.assertEqual(imported[0], imported[1])
            self.assertFalse((Path(imported[0]) / "home/coder/project").exists())
            self.assertFalse(Path(imported[0]).exists(),
                             "redundant image import source consumes the bounded worker after native base verification")
            with self.assertRaisesRegex(ValueError, "another identity"):
                self.module["image_base"](
                    {**sibling, "runtimeHostImage": "foreign"}, status, seed, digest, ["cli"])
            self.assertEqual(extraction.call_count, 1)

    def test_upgraded_images_have_independent_bases_and_preserve_the_original_import(self):
        requests = [self.request, {**self.request, "runtimeHostImage": "registry.invalid/runtime@sha256:"+"e"*64}]
        seeds = []
        imported = []
        status = {"store": str(self.root), "boot_id": "owned-boot",
                  "lifecycle": {"root": str(self.root/"controller"), "runtime_sha256": "e"*64}}
        for index in range(2):
            seed = self.root/("seed-"+str(index))
            seed.mkdir()
            with tarfile.open(seed/"rootfs.tar", "w") as archive:
                info = tarfile.TarInfo("home")
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            seeds.append(seed)

        def unpack(args, **kwargs):
            destination = Path(args[args.index("-C")+1])
            (destination/"home").mkdir(exist_ok=True)

        def base(args, **kwargs):
            source, name = args[args.index("--source")+1], args[-1]
            imported.append((source, name))
            saved = str(self.root/"controller/bases"/name/"rootfs")
            return json.dumps({"version": 1, "id": name, "source": source, "boot_id": "owned-boot",
                               "runtime_sha256": "e"*64, "prepared_at": "owned-time",
                               "tree": {"source": source, "saved": saved, "sha256": "f"*64,
                                        "immutable": {"root": saved}}}).encode()

        with patch("subprocess.run", side_effect=unpack) as extraction, \
                patch("subprocess.check_output", side_effect=base), \
                patch.dict(self.module["image_base"].__globals__, {"image_source_mounts": lambda _: False}):
            for request, seed in zip(requests, seeds):
                sha = hashlib.sha256((seed/"rootfs.tar").read_bytes()).hexdigest()
                self.module["image_base"](request, status, seed, sha, ["cli"])
            original = (self.root/"consumer-images"/sha/"prepared.json").read_bytes()
            self.module["image_base"](requests[0], status, seeds[0], sha, ["cli"])
            self.module["image_base"](requests[1], status, seeds[1], sha, ["cli"])
            self.assertEqual(extraction.call_count, 2)
            self.assertEqual(imported[0], imported[2])
            self.assertEqual(imported[1], imported[3])
            self.assertNotEqual(imported[0][1], imported[1][1])
            self.assertEqual(imported[0][1], "factory-runtime")
            self.assertLessEqual(len(imported[1][1]), 63)
            self.assertEqual((self.root/"consumer-images"/sha/"prepared.json").read_bytes(), original)
            self.assertEqual(Path(imported[1][0]).parent, seeds[1]/"import")
            self.assertFalse(Path(imported[1][0]).exists())

    def image_retirement_fixture(self):
        root = self.root / "consumer-images" / ("a" * 64)
        source = root / "source"
        source.mkdir(parents=True)
        (source / "only-import-payload").write_bytes(b"frozen image bytes")
        status = {"boot_id": "owned-boot",
                  "lifecycle": {"root": str(self.root / "controller"),
                                "runtime_sha256": "e" * 64}}
        saved = self.root / "controller/bases/factory-runtime/rootfs"
        saved.mkdir(parents=True)
        (saved / "immutable-base").write_bytes(b"preserve base")
        base = {"version": 1, "id": "factory-runtime", "source": str(source),
                "boot_id": "owned-boot", "runtime_sha256": "e" * 64,
                "prepared_at": "owned-time",
                "tree": {"source": str(source), "saved": str(saved), "sha256": "f" * 64,
                         "immutable": {"root": str(saved)}}}
        return root, source, saved, base, status

    def test_import_retirement_requires_the_exact_independent_native_base(self):
        root, source, saved, base, status = self.image_retirement_fixture()
        for field in ["version", "id", "source", "boot_id", "runtime_sha256", "prepared_at"]:
            with self.subTest(field=field):
                invalid = {**base, field: None}
                with self.assertRaisesRegex(ValueError, "independent immutable"):
                    self.module["retire_image_source"](root, invalid, status)
                self.assertTrue((source / "only-import-payload").is_file())
        invalid = {**base, "tree": {**base["tree"], "saved": str(source)}}
        with self.assertRaisesRegex(ValueError, "independent immutable"):
            self.module["retire_image_source"](root, invalid, status)
        self.assertEqual((saved / "immutable-base").read_bytes(), b"preserve base")
        self.assertFalse((root / "source-retirement.json").exists())

    def test_import_retirement_refuses_mounts_and_resumes_after_an_interrupted_unlink(self):
        root, source, saved, base, status = self.image_retirement_fixture()
        globals_ = self.module["retire_image_source"].__globals__
        with patch.dict(globals_, {"image_source_mounts": lambda _: True}), \
                patch("shutil.rmtree") as remove:
            with self.assertRaisesRegex(ValueError, "identity or mounts"):
                self.module["retire_image_source"](root, base, status)
            remove.assert_not_called()
        with patch.dict(globals_, {"image_source_mounts": lambda _: False}):
            with patch("shutil.rmtree", side_effect=OSError("owned interrupted unlink")):
                with self.assertRaisesRegex(OSError, "interrupted"):
                    self.module["retire_image_source"](root, base, status)
            self.assertTrue((root / "source-retirement.json").is_file())
            self.assertFalse((root / "source-retired.json").exists())
            self.module["retire_image_source"](root, base, status)
            self.module["retire_image_source"](root, base, status)
        self.assertFalse(source.exists())
        self.assertEqual((saved / "immutable-base").read_bytes(), b"preserve base")
        source.mkdir()
        (source / "foreign-successor").write_bytes(b"preserve successor")
        with self.assertRaisesRegex(ValueError, "successor"):
            self.module["retire_image_source"](root, base, status)
        self.assertEqual((source / "foreign-successor").read_bytes(), b"preserve successor")

    def test_import_retirement_preserves_a_replaced_partial_source_directory(self):
        root, source, saved, base, status = self.image_retirement_fixture()
        with patch.dict(self.module["retire_image_source"].__globals__,
                        {"image_source_mounts": lambda _: False}):
            with patch("shutil.rmtree", side_effect=OSError("owned interruption")):
                with self.assertRaises(OSError):
                    self.module["retire_image_source"](root, base, status)
            source.rename(root / "retained-original")
            source.mkdir()
            (source / "foreign-successor").write_bytes(b"preserve successor")
            with self.assertRaisesRegex(ValueError, "identity or mounts"):
                self.module["retire_image_source"](root, base, status)
        self.assertEqual((source / "foreign-successor").read_bytes(), b"preserve successor")
        self.assertTrue((root / "retained-original/only-import-payload").exists())
        self.assertEqual((saved / "immutable-base").read_bytes(), b"preserve base")

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


class PIDBudgetTests(unittest.TestCase):
    def setUp(self):
        self.module = runpy.run_path(sys.argv[1], run_name="factory_pid_budget_probe")

    def test_pid_ceiling_scales_with_the_finite_worker_cpu_quota_and_affinity(self):
        for quota, affinity, expected in [
                ("300000 100000", 8, 384),
                ("800000 100000", 8, 1024),
                ("1600000 100000", 16, 2048),
                ("800000 100000", 2, 384),
                ("10000 100000", 8, 384),
                ("250001 100000", 8, 384)]:
            with self.subTest(quota=quota, affinity=affinity):
                self.assertEqual(self.module["sandbox_pid_limit"](quota, affinity), expected)

    def test_unknown_unbounded_or_invalid_cpu_budgets_are_not_silently_admitted(self):
        for quota, affinity in [
                ("max 100000", 8), ("0 100000", 8), ("-1 100000", 8),
                ("800000 0", 8), ("800000 100000 extra", 8), ("", 8),
                ("800000 100000", 0), ("800000 100000", True)]:
            with self.subTest(quota=quota, affinity=affinity):
                with self.assertRaisesRegex(ValueError, "finite worker CPU"):
                    self.module["sandbox_pid_limit"](quota, affinity)

    def test_live_reader_uses_the_worker_cgroup_not_a_node_cpu_count(self):
        with patch.object(Path, "read_text", return_value="800000 100000\n") as quota, \
                patch.object(os, "sched_getaffinity", create=True, return_value=set(range(8))) as affinity:
            self.assertEqual(self.module["worker_pid_limit"](), 1024)
            quota.assert_called_once()
            affinity.assert_called_once_with(0)


if __name__ == "__main__":
    suite = unittest.TestSuite([
        unittest.defaultTestLoader.loadTestsFromTestCase(PreparationTests),
        unittest.defaultTestLoader.loadTestsFromTestCase(PIDBudgetTests),
    ])
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not outcome.wasSuccessful())
