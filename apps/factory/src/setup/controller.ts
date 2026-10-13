import { createHmac } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { ForgeAmbiguousWriteError } from "../../../../packages/forge/src/forge";
import {
  type ProjectSetupView,
  projectImportURL,
  projectSetupCreate,
  projectSetupSave,
  projectSetupView,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { ImportSecrets } from "./secrets";
import { starterFiles } from "./starter";

type Database = ReturnType<typeof createDatabase>;
type Intent = {
  commandID: string;
  setupID: string;
  userID: string;
  projectID: string;
  name: string;
  slug: string;
  kind: "starter" | "import";
  sourceURL: string;
  credentialKey: string | null;
  fingerprint: string;
  state: string;
};

export function createProjectSetupController(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoClient>;
  forgeOwner: string;
  forgeOrigin: string;
  secrets: ImportSecrets;
  signingKey: string;
  importOrigins: readonly string[];
  onCreated(projectID: string, userID: string): Promise<void>;
}) {
  const sql = options.database.client;
  const access = createAccessController(options.database);
  const conflict = () =>
    new CommandError("conflict", "Project setup changed. Reload before continuing.");
  const unavailable = () =>
    new CommandError(
      "unavailable",
      "Repository setup needs another status check. Your setup is retained.",
    );

  async function view(userID: string): Promise<ProjectSetupView | null> {
    await access.requireSystemManager(userID);
    const [row] = await sql`SELECT id,version::float8 AS version,name,slug,kind,
      source_url AS "sourceURL",state,project_id AS "projectID",command_id AS "commandID",failure
      FROM factory.project_setup_draft WHERE user_id=${userID}`;
    return row ? projectSetupView.parse(row) : null;
  }

  async function begin(userID: string) {
    await access.requireSystemManager(userID);
    const id = crypto.randomUUID();
    await sql`INSERT INTO factory.project_setup_draft(id,user_id) VALUES(${id},${userID})
      ON CONFLICT(user_id) DO UPDATE SET id=CASE WHEN factory.project_setup_draft.state='created' THEN EXCLUDED.id ELSE factory.project_setup_draft.id END,
      version=CASE WHEN factory.project_setup_draft.state='created' THEN 1 ELSE factory.project_setup_draft.version END,
      name=CASE WHEN factory.project_setup_draft.state='created' THEN '' ELSE factory.project_setup_draft.name END,
      slug=CASE WHEN factory.project_setup_draft.state='created' THEN '' ELSE factory.project_setup_draft.slug END,
      kind=CASE WHEN factory.project_setup_draft.state='created' THEN 'starter' ELSE factory.project_setup_draft.kind END,
      source_url=CASE WHEN factory.project_setup_draft.state='created' THEN '' ELSE factory.project_setup_draft.source_url END,
      project_id=CASE WHEN factory.project_setup_draft.state='created' THEN NULL ELSE factory.project_setup_draft.project_id END,
      command_id=CASE WHEN factory.project_setup_draft.state='created' THEN NULL ELSE factory.project_setup_draft.command_id END,
      failure=CASE WHEN factory.project_setup_draft.state='created' THEN NULL ELSE factory.project_setup_draft.failure END,
      state=CASE WHEN factory.project_setup_draft.state='created' THEN 'draft' ELSE factory.project_setup_draft.state END`;
    return view(userID);
  }

  async function save(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupSave.parse(input);
    const rows =
      await sql`UPDATE factory.project_setup_draft SET name=${value.name},slug=${value.slug},
      kind=${value.kind},source_url=${value.sourceURL},version=version+1,updated_at=now()
      WHERE id=${value.id} AND user_id=${userID} AND version=${value.version} AND state='draft' RETURNING id`;
    if (!rows.length) throw conflict();
    return view(userID);
  }

  async function intent(commandID: string): Promise<Intent | undefined> {
    const [row] = await sql<
      Intent[]
    >`SELECT command_id AS "commandID",setup_id AS "setupID",user_id AS "userID",
      project_id AS "projectID",name,slug,kind,source_url AS "sourceURL",credential_key AS "credentialKey",fingerprint,state
      FROM factory.project_repository_intent WHERE command_id=${commandID}`;
    return row;
  }

  async function removeCredential(row: Intent) {
    if (!row.credentialKey) return;
    const [active] =
      await sql`SELECT command_id FROM factory.project_repository_intent WHERE command_id=${row.commandID} AND credential_removed_at IS NULL`;
    if (!active) return;
    await options.secrets.remove(row.credentialKey);
    await sql`UPDATE factory.project_repository_intent SET credential_removed_at=COALESCE(credential_removed_at,now()) WHERE command_id=${row.commandID}`;
  }

  async function finish(row: Intent, branch: string) {
    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
      const [manager] =
        await transaction`SELECT user_id FROM factory.administrator WHERE user_id=${row.userID} FOR SHARE`;
      if (!manager) throw new CommandError("forbidden", "System Manager access required");
      const [locked] =
        await transaction`SELECT state FROM factory.project_repository_intent WHERE command_id=${row.commandID} FOR UPDATE`;
      if (locked?.["state"] === "committed") return;
      const url = new URL(
        `${encodeURIComponent(options.forgeOwner)}/${encodeURIComponent(row.slug)}`,
        `${options.forgeOrigin}/`,
      ).toString();
      await transaction`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${row.projectID},${row.slug},${row.name},${url},${branch},'.devcontainer/devcontainer.json',${row.userID})`;
      await transaction`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${row.projectID},${row.userID},'developer',true,${row.userID})`;
      await transaction`UPDATE factory.project_repository_intent SET state='committed',default_branch=${branch},failure=NULL,completed_at=now() WHERE command_id=${row.commandID}`;
      await transaction`UPDATE factory.project_setup_draft SET state='created',project_id=${row.projectID},failure=NULL,updated_at=now()
        WHERE id=${row.setupID} AND user_id=${row.userID} AND command_id=${row.commandID}`;
    });
    await removeCredential(row);
    await options.onCreated(row.projectID, row.userID);
  }

  async function execute(row: Intent, authorizeCreate: boolean) {
    // Cross-process serialization covers the external call, not just SQL intent.
    const connection = await sql.reserve();
    try {
      const [lock] = await connection<
        { held: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext(${`project-setup:${row.setupID}`})) AS held`;
      if (!lock?.held) return;
      try {
        await access.requireSystemManager(row.userID);
        const current = await intent(row.commandID);
        if (!current) throw conflict();
        if (current.state === "committed") {
          await removeCredential(current);
          return;
        }
        const repository = { owner: options.forgeOwner, name: row.slug };
        let observed = await options.forge.setupRepository(repository, row.setupID);
        if (!observed) {
          if (!authorizeCreate) {
            await sql`UPDATE factory.project_repository_intent SET state='uncertain' WHERE command_id=${row.commandID}`;
            await sql`UPDATE factory.project_setup_draft SET state='checking',failure='Repository creation is still unconfirmed. Check again; Factory will not duplicate the import.' WHERE id=${row.setupID}`;
            return;
          }
          let token: string | undefined;
          if (row.credentialKey) {
            const stored = await options.secrets.read(row.credentialKey);
            if (
              !stored ||
              stored.commandID !== row.commandID ||
              stored.fingerprint !== row.fingerprint
            )
              throw unavailable();
            token = stored.token;
          }
          await sql`UPDATE factory.project_repository_intent SET state='create-intended' WHERE command_id=${row.commandID}`;
          observed = await options.forge.createSetupRepository({
            repository,
            setupID: row.setupID,
            ...(row.kind === "import" ? { sourceURL: row.sourceURL } : {}),
            ...(token ? { importToken: token } : {}),
          });
        }
        if (row.kind === "starter") {
          const files = await starterFiles();
          const head = await options.forge.getBranch(repository, observed.defaultBranch || "main");
          if (!head) {
            await sql`UPDATE factory.project_repository_intent SET state='repository-ready' WHERE command_id=${row.commandID}`;
            await options.forge.createSetupFiles({
              repository,
              branch: "main",
              files,
              setupID: row.setupID,
            });
          } else {
            // Lost initialization response is recoverable only from the whole
            // exact template, never a README marker or a guessed empty tree.
            const inventory = await options.forge.listFiles(repository, head.headSha);
            if (inventory.length !== files.length) throw conflict();
            for (const file of files)
              if (
                (await options.forge.getFile(repository, file.path, head.headSha)) !== file.content
              )
                throw conflict();
          }
          observed = { defaultBranch: "main", empty: false };
        }
        const head = await options.forge.getBranch(repository, observed.defaultBranch);
        if (!head || observed.empty) throw unavailable();
        await finish(row, observed.defaultBranch);
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${`project-setup:${row.setupID}`}))`;
      }
    } catch (error) {
      const ambiguous =
        error instanceof ForgeAmbiguousWriteError ||
        (error instanceof CommandError && error.code === "unavailable");
      await sql`UPDATE factory.project_repository_intent SET state=${ambiguous ? "uncertain" : "failed"},failure=${ambiguous ? "Repository setup needs a status check." : "Repository setup could not finish. Check the repository access and try again."}
        WHERE command_id=${row.commandID} AND state<>'committed'`;
      await sql`UPDATE factory.project_setup_draft SET state=${ambiguous ? "checking" : "failed"},failure=${ambiguous ? "Repository setup needs a status check." : "Repository setup could not finish. Check repository access."}
        WHERE id=${row.setupID} AND state<>'created'`;
    } finally {
      connection.release();
    }
  }

  async function create(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupCreate.parse(input);
    const admitted = await sql.begin(async (transaction) => {
      const [draft] =
        await transaction`SELECT * FROM factory.project_setup_draft WHERE user_id=${userID} FOR UPDATE`;
      if (!draft || draft["id"] !== value.id) throw conflict();
      if (draft["command_id"]) {
        if (draft["command_id"] !== value.commandID) throw conflict();
        return false;
      }
      if (
        Number(draft["version"]) !== value.version ||
        draft["state"] !== "draft" ||
        !draft["name"] ||
        !draft["slug"]
      )
        throw conflict();
      const sourceURL =
        draft["kind"] === "import"
          ? projectImportURL(String(draft["source_url"]), options.importOrigins)
          : "";
      if (value.importToken && draft["kind"] !== "import") throw conflict();
      if (value.importToken && !options.secrets.configured) throw unavailable();
      const projectID = crypto.randomUUID();
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: value.id,
            name: draft["name"],
            slug: draft["slug"],
            kind: draft["kind"],
            sourceURL,
            token: value.importToken ?? "",
          }),
        )
        .digest("hex");
      const key = value.importToken ? `imports/${value.id}/${value.commandID}` : null;
      await transaction`INSERT INTO factory.project_repository_intent(command_id,setup_id,user_id,project_id,name,slug,kind,source_url,credential_key,fingerprint,state)
        VALUES(${value.commandID},${value.id},${userID},${projectID},${String(draft["name"])},${String(draft["slug"])},${String(draft["kind"])},${sourceURL},${key},${fingerprint},${key ? "credential-intended" : "create-intended"})`;
      await transaction`UPDATE factory.project_setup_draft SET state='creating',command_id=${value.commandID},failure=NULL WHERE id=${value.id}`;
      return true;
    });
    const row = await intent(value.commandID);
    if (!row || row.userID !== userID) throw conflict();
    if (value.importToken) {
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: row.setupID,
            name: row.name,
            slug: row.slug,
            kind: row.kind,
            sourceURL: row.sourceURL,
            token: value.importToken,
          }),
        )
        .digest("hex");
      if (fingerprint !== row.fingerprint) throw conflict();
    }
    if (row.state === "credential-intended") {
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: row.setupID,
            name: row.name,
            slug: row.slug,
            kind: row.kind,
            sourceURL: row.sourceURL,
            token: value.importToken ?? "",
          }),
        )
        .digest("hex");
      const existing = row.credentialKey
        ? await options.secrets.read(row.credentialKey)
        : undefined;
      if (!existing) {
        if (fingerprint !== row.fingerprint || !value.importToken || !row.credentialKey)
          throw conflict();
        await options.secrets.create(row.credentialKey, {
          commandID: row.commandID,
          fingerprint: row.fingerprint,
          token: value.importToken,
        });
      } else if (existing.commandID !== row.commandID || existing.fingerprint !== row.fingerprint)
        throw conflict();
    }
    await execute(row, admitted || row.state === "credential-intended");
    return view(userID);
  }

  async function check(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID) throw conflict();
    if (draft.commandID) {
      const row = await intent(draft.commandID);
      if (row) await execute(row, false);
    }
    return view(userID);
  }

  async function retry(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID || draft.state !== "failed" || !draft.commandID)
      throw conflict();
    const row = await intent(draft.commandID);
    if (!row || row.state !== "failed") throw conflict();
    await execute(row, true);
    return view(userID);
  }

  async function recover() {
    const rows = await sql<{ userID: string; id: string }[]>`SELECT user_id AS "userID",id
      FROM factory.project_setup_draft WHERE command_id IS NOT NULL AND state IN ('creating','checking')`;
    for (const row of rows) await check(row.userID, row.id);
    const completed = await sql<
      { commandID: string }[]
    >`SELECT command_id AS "commandID" FROM factory.project_repository_intent WHERE state='committed' AND credential_key IS NOT NULL AND credential_removed_at IS NULL`;
    for (const row of completed) {
      const saved = await intent(row.commandID);
      if (saved) await removeCredential(saved);
    }
  }
  return { view, begin, save, create, check, retry, recover };
}
