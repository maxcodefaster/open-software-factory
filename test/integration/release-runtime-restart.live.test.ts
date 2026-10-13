import { expect, test } from "bun:test";
import { releaseInstallation } from "../fixtures/release-installation";
import { eventually } from "../fixtures/factory-process";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "ready native Ticket and Staging reconnect to the same attempts after restart",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const f = await releaseInstallation(installation);
    try {
      const { projectID, dependentChangeID } = f.state;
      if (!projectID || !dependentChangeID) throw new Error("Complete release journey required");
      const read = () => f.database.client<
        Array<{
          id: string;
          state: string;
          workspace_id: string | null;
          kubernetes_uid: string;
          kubernetes_namespace_uid: string;
        }>
      >`
      SELECT attempt.id, attempt.state, attempt.workspace_id, attempt.kubernetes_uid, attempt.kubernetes_namespace_uid
      FROM factory.runtime_attempt attempt WHERE attempt.id IN
      (SELECT runtime_attempt_id FROM factory.change WHERE id = ${dependentChangeID}
       UNION SELECT runtime_attempt_id FROM factory.staging_preview WHERE project_id = ${projectID}) ORDER BY attempt.id`;
      const before = await eventually(
        read,
        (rows) => rows.length === 2 && rows.every((row) => row.state === "ready"),
        "Native runtimes not ready before restart",
        300_000,
      );
      const turns = await f.database
        .client`SELECT id, state FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY id`;
      const started = Date.now();
      const child = Bun.spawn(
        [process.execPath, "scripts/factory/index.ts", "restart", "--disposable", installation],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      f.noSecrets(output + error);
      expect(status).toBe(0);
      const states: Array<{ elapsedMS: number; attempts: Array<{ id: string; state: string }> }> =
        [];
      const after = await eventually(
        async () => {
          const rows = await read();
          const attempts = rows.map(({ id, state }) => ({ id, state }));
          if (JSON.stringify(states.at(-1)?.attempts) !== JSON.stringify(attempts))
            states.push({ elapsedMS: Date.now() - started, attempts });
          return rows;
        },
        (rows) =>
          rows.length === 2 &&
          rows.every((row) => ["ready", "failed", "stopped"].includes(row.state)),
        "Native connectors did not settle",
        90_000,
      );
      await f.record("native-restart", { before: [...before], after: [...after], states });
      expect([...after]).toEqual([...before]);
      expect([
        ...(await f.database
          .client`SELECT id, state FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY id`),
      ]).toEqual([...turns]);
    } finally {
      await f.close();
    }
  },
  420_000,
);
