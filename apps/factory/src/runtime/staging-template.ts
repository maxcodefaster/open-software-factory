import { createHash } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { ExecutionSlot, ReserveRole } from "../../../../packages/runtime-domain/src/reserve";
import { runInputStreamCommand } from "../../../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../../../packages/runtime-kubernetes/src/config";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeProfile,
  factoryboxRuntimeRequest,
} from "../../../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  type FactoryboxWorkerIdentity,
  inspectFactoryboxWorker,
} from "../../../../packages/runtime-kubernetes/src/factorybox-worker";
import { cleanRuntimeSourceArchive } from "./git-http";
import type { createReserveStore } from "./reserve-store";
import { stagingConfiguration } from "./staging-configuration";

type Database = ReturnType<typeof createDatabase>;
type Store = ReturnType<typeof createReserveStore>;

export function createStagingTemplateProducer(
  database: Database,
  store: Store,
  images: Readonly<Record<ReserveRole, string>>,
) {
  return {
    async refresh() {
      const [candidate] = await database.client<
        Array<{
          projectID: string;
          stagingAttemptID: string;
          revision: string;
          repositoryURL: string;
          devcontainerPath: string;
          runtimeHostImage: string;
          profile: unknown;
          declaration: unknown;
        }>
      >`SELECT project.id AS "projectID",staging.id AS "stagingAttemptID",staging.revision,
          project.repository_url AS "repositoryURL",configuration.declaration->>'devcontainerPath' AS "devcontainerPath",
          artifact.runtime_host_image AS "runtimeHostImage",artifact.factorybox_profile AS profile,configuration.declaration
        FROM factory.staging_preview preview JOIN factory.project project ON project.id=preview.project_id
        JOIN factory.runtime_attempt staging ON staging.id=preview.runtime_attempt_id AND staging.revision=preview.revision
        JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=staging.id
        JOIN factory.staging_configuration configuration ON configuration.runtime_attempt_id=staging.id
        LEFT JOIN factory.runtime_environment_intent environment ON environment.runtime_attempt_id=staging.id
        LEFT JOIN factory.environment_write environment_write ON environment_write.secret_key=environment.secret_key AND environment_write.state='committed'
        WHERE staging.state='ready' AND staging.stop_intended_at IS NULL
          AND (environment.secret_key IS NULL OR environment_write.manifest='{"variables":[],"registries":[]}'::jsonb)
        ORDER BY greatest(preview.updated_at,coalesce((SELECT max(created_at) FROM factory.runtime_attempt demand
          WHERE demand.project_id=project.id),preview.updated_at)) DESC,project.id LIMIT 1`;
      if (!candidate || candidate.runtimeHostImage !== images.staging) return;
      const profile = factoryboxRuntimeProfile.parse(candidate.profile);
      const declaration = stagingConfiguration.parse(candidate.declaration);
      const key = createHash("sha256")
        .update(JSON.stringify({ ...candidate, profile, declaration }))
        .digest("hex");
      if (await store.hasTemplate(database.client, key)) return;
      const id = crypto.randomUUID();
      const recipe = {
        version: 1,
        runtimeAttemptId: id,
        generation: 1,
        workspaceFolder: "/home/coder/project",
        remoteWorkspaceFolder: "/workspace/project",
        repositoryUrl: `https://unassigned.invalid/${candidate.projectID}.git`,
        repositoryIdentity: candidate.projectID,
        preserveWorkspace: false,
        revision: candidate.revision,
        devcontainerPath: candidate.devcontainerPath,
        composeProjectName: `template_${id.replaceAll("-", "")}`,
        controlUrl: "ws://unassigned.invalid/",
        connectorStateDir: "/home/coder/connector-state",
        channels: declaration.channels,
        processes: declaration.processes,
      };
      await database.client.begin((sql) =>
        store.offerTemplate(sql, { ...candidate, id, key, recipe, profile }),
      );
    },
    async importSource(
      slot: ExecutionSlot,
      input: FactoryboxRuntimeInput,
      identity: FactoryboxWorkerIdentity,
      intent: (sha256: string) => Promise<boolean>,
      complete: (observation: unknown) => Promise<void>,
    ) {
      if (!slot.projectID || !slot.revision || slot.templateID)
        throw new Error("Source import requires a clean Project template");
      await inspectFactoryboxWorker(
        factoryboxRuntimeRequest(input),
        identity,
        undefined,
        factoryboxRuntimeDeclaration(input),
      );
      let archive: Awaited<ReturnType<typeof cleanRuntimeSourceArchive>> | undefined;
      let sha256 = slot.sourceImportSHA256;
      if (!sha256) {
        const [project] = await database.client<
          Array<{ url: string }>
        >`SELECT repository_url AS url FROM factory.project WHERE id=${slot.projectID}`;
        if (!project) throw new Error("Template Project is unavailable");
        archive = await cleanRuntimeSourceArchive(project.url, slot.revision, slot.projectID);
        sha256 = archive.sha256;
      }
      try {
        const admitted = archive ? await intent(sha256) : false;
        if (archive && !admitted) throw new Error("Source import already has an original intent");
        const request = {
          storeID: identity.storeID,
          epoch: identity.epoch,
          sandboxID: input.sandboxID,
          sha256,
          upload: admitted,
        };
        const program = `import hashlib,json,os,pathlib,subprocess,sys,tarfile,tempfile
r=json.loads(sys.argv[1])
s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
if s['store_id']!=r['storeID'] or s['epoch']!=r['epoch']:raise ValueError('Template worker changed')
root=pathlib.Path(s['store'])/'input'/r['sandboxID']
receipt=root/'source-import.json'
if receipt.exists():
 value=json.loads(receipt.read_text())
 if value.get('sha256')!=r['sha256']:raise ValueError('Template import identity changed')
 print(json.dumps(value));sys.exit(0)
if not r['upload']:raise ValueError('Original source import remains unconfirmed')
target=root/'bundle/rootfs/home/coder/project'
if target.exists() or target.is_symlink():raise ValueError('Private template source already exists')
with tempfile.TemporaryFile(dir=root) as file:
 digest=hashlib.sha256();size=0
 while True:
  block=sys.stdin.buffer.read(1024*1024)
  if not block:break
  digest.update(block);file.write(block);size+=len(block)
 if digest.hexdigest()!=r['sha256']:raise ValueError('Source transfer hash differs')
 file.seek(0);target.mkdir()
 with tarfile.open(fileobj=file) as archive:archive.extractall(target,filter='data')
for base,dirs,files in os.walk(target):
 os.chown(base,1000,1000)
 for name in files:os.chown(pathlib.Path(base)/name,1000,1000,follow_symlinks=False)
value={'version':1,'sha256':r['sha256'],'bytes':size,'sandboxID':r['sandboxID'],'storeID':r['storeID'],'epoch':r['epoch']}
with receipt.open('x') as file:json.dump(value,file);file.flush();os.fsync(file.fileno())
print(json.dumps(value))`;
        const result = await runInputStreamCommand(
          kubernetesCommand([
            "--request-timeout=0",
            "exec",
            "-i",
            input.podName,
            "-n",
            input.namespace,
            "-c",
            "worker",
            "--",
            "python3",
            "-c",
            program,
            JSON.stringify(request),
          ]),
          archive?.file.stream() ??
            new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          { timeoutMS: 180_000, outputBytes: 16 * 1024 },
        );
        if (result.exitCode !== 0) throw new Error("Template source import is unconfirmed");
        const observation = JSON.parse(result.stdout);
        if (
          observation.sha256 !== sha256 ||
          observation.sandboxID !== input.sandboxID ||
          observation.storeID !== identity.storeID ||
          observation.epoch !== identity.epoch
        )
          throw new Error("Template source receipt differs");
        await complete(observation);
      } finally {
        await archive?.cleanup();
      }
    },
  };
}
