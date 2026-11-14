import { expect, test } from "bun:test";
import { z } from "zod";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

for (const recovered of [false, true])
  test.each(["personal", "ticket", "staging"] as const)(
    `native ${recovered ? "lost-reply continuation" : "startup"} freezes published App origins for %s`,
    async (kind) => {
      const f = await nativeRuntimeFixture(kind === "ticket" ? "ticket" : "personal");
      const previous = process.env["FACTORY_BASE_URL"];
      try {
        const start = (runtime: ReturnType<typeof f.controller>) =>
          kind === "personal"
            ? runtime.start(f.projectID, f.userID)
            : kind === "ticket"
              ? runtime.startPersisted(f.changeID, f.userID)
              : runtime.ensureStaging(f.projectID, f.userID);
        process.env["FACTORY_BASE_URL"] = "https://irrelevant-browser.example";
        if (recovered) {
          f.loseNext("CreateAtespace");
          await expect(start(f.controller())).rejects.toThrow("Owned lost native reply");
          process.env["FACTORY_BASE_URL"] = "https://changed-browser.example";
        }
        const runtime = f.controller();
        const attempt = await start(runtime);
        if (!attempt) throw Error("Owned native App runtime was not admitted");
        const template = z
          .object({
            containers: z.array(
              z.object({
                env: z.array(z.object({ name: z.string(), value: z.string() })),
              }),
            ),
          })
          .parse(f.resources.get(`fa-${attempt.id.replaceAll("-", "")}`)?.get("ActorTemplate"));
        const encoded = template.containers
          .flatMap((container) => container.env)
          .find((env) => env.name === "FACTORY_SUBSTRATE_BOOTSTRAP")?.value;
        const bootstrap = z
          .object({
            assignment: z.object({
              runtimeAttemptId: z.string(),
              processes: z.array(
                z.object({ name: z.string(), env: z.record(z.string(), z.string()).optional() }),
              ),
            }),
          })
          .parse(JSON.parse(encoded ?? "null"));
        const origin = `https://${new URL(f.configuration.connectorURL).host}`;
        const expected = {
          "4321": appRuntimeOrigin(origin, attempt.id, "app"),
          "3002": appRuntimeOrigin(origin, attempt.id, "app-editor"),
          "3001": appRuntimeOrigin(origin, attempt.id, "app-api"),
        };
        expect(bootstrap.assignment.runtimeAttemptId).toBe(attempt.id);
        for (const name of ["app", "app-editor", "app-api"])
          expect(
            bootstrap.assignment.processes.find((process) => process.name === name)?.env?.[
              "FACTORY_APP_ORIGINS"
            ],
          ).toBe(JSON.stringify(expected));
        for (const process of bootstrap.assignment.processes.filter(
          (process) => !process.name.startsWith("app"),
        ))
          expect(process.env?.["FACTORY_APP_ORIGINS"]).toBeUndefined();
        const creates = f.calls.filter((call) => call.method === "CreateActor").length;
        expect((await start(f.controller()))?.id).toBe(attempt.id);
        expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(creates);
        expect(f.calls.filter((call) => call.method === "ResumeActor")).toHaveLength(1);
        expect(
          await f.database.client`SELECT to_regclass('factory.runtime_artifact_intent') AS legacy`,
        ).toEqual(expect.arrayContaining([{ legacy: null }]));
      } finally {
        if (previous === undefined) delete process.env["FACTORY_BASE_URL"];
        else process.env["FACTORY_BASE_URL"] = previous;
        await f.dispose();
      }
    },
    60_000,
  );
