import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

test("Factory ships its Greenfield baseline and concrete retained-operation upgrades", async () => {
  const directory = resolve(import.meta.dir, "../migrations");
  const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  expect(files).toEqual([
    "0001_baseline.sql",
    "0002_worker_admissions.sql",
    "0003_worker_declarations.sql",
    "0004_worker_store_recovery.sql",
    "0005_promotion_retries.sql",
    "0006_ticket_execution_revision.sql",
    "0007_execution_template_basis.sql",
    "0008_public_image_build_inputs.sql",
    "0009_execution_template_availability.sql",
    "0010_slot_retirement_progress.sql",
    "0011_fresh_worker_storage.sql",
    "0012_runtime_app_origins.sql",
  ]);
});
