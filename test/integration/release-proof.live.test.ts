import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expect as visible } from "@playwright/test";
import { z } from "zod";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { inheritedModelSettingsView } from "../../packages/conversation-domain/src/model-inheritance";
import {
  inheritedSkillSettingsView,
  systemSkillSettingsView,
} from "../../packages/conversation-domain/src/skill-inheritance";
import { releaseInstallation } from "../fixtures/release-installation";
import { releasePlanning } from "../fixtures/release-planning";
import { releaseBuild, releaseInspection } from "../fixtures/release-build";
import { releaseWorkspace } from "../fixtures/release-workspace";
import { releaseDelivery } from "../fixtures/release-delivery";
import { releaseDependent } from "../fixtures/release-dependent";
import { releaseVisuals, releaseProductVisuals } from "../fixtures/release-visuals";
import { releaseCleanup } from "../fixtures/release-cleanup";
import { eventually } from "../fixtures/factory-process";

const installationName = process.env["FACTORY_RELEASE_INSTALLATION"];
const phase = process.env["FACTORY_RELEASE_PHASE"] ?? "setup";
test.skipIf(!installationName)(
  `real isolated customer journey: ${phase}`,
  async () => {
    if (!installationName) throw new Error("Explicit disposable release installation required");
    const fixture = await releaseInstallation(installationName);
    const { state, database } = fixture;
    const started = performance.now();
    try {
      if (phase === "signin") {
        const page = await fixture.page("admin");
        await page.screenshot({ path: resolve(fixture.evidence, "signin-wide.png") });
        await fixture.save("signin", performance.now() - started);
        return;
      }
      if (phase === "planning") {
        await releasePlanning(fixture);
        await fixture.save("planning", performance.now() - started);
        console.info(
          "Release proof: genuine cited Investigate, adaptive choices/custom answer and immutable approved Spec passed",
        );
        return;
      }
      if (phase === "build") {
        await releaseBuild(fixture);
        await fixture.save("build", performance.now() - started);
        console.info(
          "Release proof: real UI Build, duplicate admission, restricted browser and exact Verification passed",
        );
        return;
      }
      if (phase === "inspection") {
        await releaseInspection(fixture);
        console.info(
          "Release proof: genuine DOM/console/JPEG inspection and focused regression verified",
        );
        return;
      }
      if (phase === "workspace") {
        await releaseWorkspace(fixture);
        console.info(
          "Release proof: real Theia, interactive retained PTY, process Stop/Start/Restart and development Preview passed",
        );
        return;
      }
      if (phase === "delivery") {
        await releaseDelivery(fixture);
        console.info(
          "Release proof: exact human Delivery Approval, merge and healthy promoted Staging passed",
        );
        return;
      }
      if (phase === "dependent") {
        await releaseDependent(fixture);
        console.info(
          state.dependentRetryCommandID
            ? "Release proof: delivered base and actual required Build Skill verified. Restart retained exact identities; interrupted inference required an explicit new turn."
            : "Release proof: delivered base, actual required Build Skill and running-turn restart recovery passed",
        );
        return;
      }
      if (phase === "visuals") {
        await releaseVisuals(fixture);
        console.info(
          "Release proof: actual administration roles, models, Skills and access screenshots captured",
        );
        return;
      }
      if (phase === "final-visuals") {
        await releaseProductVisuals(fixture);
        await fixture.save("final-visuals", performance.now() - started);
        console.info(
          "Release proof: final board, menus, Agent, Spec, Knowledge, IDE and Staging screenshots captured",
        );
        return;
      }
      if (phase === "cleanup") {
        await releaseCleanup(fixture);
        console.info(
          "Release proof: compact final records retained; exact owned runtimes removed and unrelated namespaces unchanged",
        );
        return;
      }
      const admin = await fixture.login("admin");
      const modelId = process.env["FACTORY_AGENT_MODEL_ID"];
      if (!modelId) throw new Error("Deployed model required");
      if (phase !== "setup") throw new Error("Release phase is not implemented yet");
      const adminPage = await fixture.page("admin");
      const projects = z
        .object({
          projects: z.array(
            z.object({ id: z.uuid(), slug: z.string(), repositoryUrl: z.string() }),
          ),
        })
        .parse(await fixture.command(admin, "/api/projects"));
      let project = projects.projects.find((value) => value.slug === fixture.slug);
      if (!project) {
        await adminPage.getByRole("button", { name: "Open project menu" }).click();
        await adminPage.getByRole("button", { name: "Add project", exact: true }).click();
        await adminPage.getByLabel("Name", { exact: true }).fill("Release proof");
        await adminPage.getByLabel("Slug", { exact: true }).fill(fixture.slug);
        await adminPage.getByLabel("Repository URL", { exact: true }).fill(fixture.repositoryURL);
        await adminPage.getByRole("button", { name: "Register Project", exact: true }).click();
        project = await eventually(
          async () =>
            z
              .object({
                projects: z.array(
                  z.object({ id: z.uuid(), slug: z.string(), repositoryUrl: z.string() }),
                ),
              })
              .parse(await fixture.command(admin, "/api/projects"))
              .projects.find((value) => value.slug === fixture.slug),
          (value) => !!value,
          "Project was not registered through the UI",
        );
      } else await fixture.selectProject(adminPage);
      if (!project || project.repositoryUrl !== fixture.repositoryURL)
        throw new Error("Release Project does not own the isolated repository");
      state.projectID = project.id;
      const projectID = project.id;
      const users = z
        .object({ users: z.array(z.object({ id: z.uuid(), email: z.string() })) })
        .parse(await fixture.command(admin, "/api/admin/users"));
      for (const role of ["manager", "developer", "outsider"] as const) {
        if (!users.users.some((user) => user.email === fixture.credentials(role).email))
          await fixture.command(admin, "/api/admin/users", "POST", {
            name: `Release ${role}`,
            ...fixture.credentials(role),
          });
      }
      await fixture.command(admin, `/api/projects/${project.id}/members`, "POST", {
        email: fixture.credentials("manager").email,
        role: "developer",
        manageProject: true,
      });
      const manager = await fixture.login("manager");
      await fixture.command(manager, `/api/projects/${project.id}/members`, "POST", {
        email: fixture.credentials("developer").email,
        role: "developer",
      });
      const developer = await fixture.login("developer");
      const outsider = await fixture.login("outsider");
      const modelsPath = `/api/projects/${project.id}/model-settings`;
      const defaults = inheritedModelSettingsView.parse(await fixture.command(manager, modelsPath));
      await fixture.command(manager, modelsPath, "PUT", {
        version: defaults.project.version,
        planning: { modelId, models: [modelId], allowOverride: true },
        build: { modelId, models: [modelId], allowOverride: true },
      });
      const deniedModel = await fixture.request(developer, `${modelsPath}/personal`, "PUT", {
        version: 0,
        planningModelId: "unapproved-release-model",
        buildModelId: null,
      });
      expect(deniedModel.status).toBe(409);
      expect(deniedModel.body).toMatchObject({
        error: "Personal selection is locked or not approved by the current rules",
      });
      expect((await fixture.request(outsider, modelsPath)).status).toBe(404);
      expect((await fixture.request(developer, "/api/model-settings")).status).toBe(403);
      const skills = systemSkillSettingsView.parse(
        await fixture.command(admin, "/api/admin/skills"),
      );
      const planning = skills.revisions.find(
        (value) => value.content.key === requirementsInterviewSkill.key && value.published,
      );
      if (!planning) throw new Error("Installation's published interview Skill is missing");
      state.planningSkillID = planning.id;
      await fixture.command(admin, "/api/admin/skills/settings", "PUT", {
        version: skills.settings.version,
        planning: { required: [planning.id], optional: [], selected: [] },
        build: { required: [], optional: [], selected: [] },
      });
      const projectSkillsPath = `/api/projects/${project.id}/skill-settings`;
      const projectSkills = inheritedSkillSettingsView.parse(
        await fixture.command(manager, projectSkillsPath),
      );
      expect(projectSkills.effective.planning.required.map((value) => value.revisionId)).toEqual([
        planning.id,
      ]);
      expect((await fixture.request(outsider, projectSkillsPath)).status).toBe(404);
      const page = await fixture.page("developer");
      await fixture.selectProject(page);
      const epics = await database.client<
        Array<{ id: string; title: string; parentID: string | null }>
      >`SELECT id, title, parent_id AS "parentID" FROM factory.epic WHERE project_id = ${project.id}`;
      async function epic(title: string, parentID?: string) {
        const existing = epics.find((value) => value.title === title);
        if (existing) return existing.id;
        await page.getByRole("button", { name: "New Ticket", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "New ticket", exact: true });
        await dialog.getByLabel("Work type").selectOption("epic");
        await dialog.getByLabel("Ticket title").fill(title);
        if (parentID) await dialog.getByLabel("Parent Epic").selectOption(parentID);
        await dialog.getByRole("button", { name: "Create Epic", exact: true }).click();
        await visible(dialog).toBeHidden();
        const row = await eventually(
          async () => {
            const [row] = await database.client<
              Array<{ id: string }>
            >`SELECT id FROM factory.epic WHERE project_id = ${projectID} AND title = ${title}`;
            return row;
          },
          (value) => !!value,
          "Epic was not confirmed through actual Zero UI",
        );
        if (!row) throw new Error("Epic confirmation missing");
        return row.id;
      }
      state.rootEpicID = await epic("Product release");
      state.childEpicID = await epic("Developer welcome", state.rootEpicID);
      await page.getByLabel("Filter by Epic").selectOption(state.childEpicID);
      const tickets = await database.client<
        Array<{ id: string; title: string }>
      >`SELECT id, title FROM factory.ticket WHERE project_id = ${project.id}`;
      async function ticket(title: string, description: string) {
        const existing = tickets.find((value) => value.title === title);
        const minimize = page.getByRole("button", { name: "Minimize workspace", exact: true });
        if (await minimize.isVisible()) await minimize.click();
        if (existing) {
          await page
            .getByRole("region", { name: "Ticket board" })
            .locator(".ticket-card-body")
            .filter({ hasText: title })
            .click();
        } else {
          await page.getByRole("button", { name: "New Ticket", exact: true }).click();
          await page.getByLabel("Ticket title", { exact: true }).fill(title);
          await page.getByLabel("Ticket description", { exact: true }).fill(description);
          await page.getByRole("button", { name: "Create Ticket", exact: true }).click();
        }
        await visible(page.getByRole("textbox", { name: "Ticket title", exact: true })).toHaveText(
          title,
        );
        await visible(page.getByLabel("Ticket Epic", { exact: true })).toBeVisible();
        await page.getByLabel("Ticket Epic", { exact: true }).selectOption(state.childEpicID ?? "");
        const row = await eventually(
          async () => {
            const [row] = await database.client<
              Array<{ id: string }>
            >`SELECT id FROM factory.ticket WHERE project_id = ${projectID} AND title = ${title}
              AND epic_id = ${state.childEpicID ?? ""}`;
            return row;
          },
          (value) => !!value,
          "Ticket was not confirmed through actual Zero UI",
        );
        if (!row) throw new Error("Ticket confirmation missing");
        return row.id;
      }
      state.ticketID = await ticket(
        "Welcome dashboard",
        "Build a readable developer welcome dashboard in the declared App. Preserve its /health and /source endpoints and the existing runtime configuration.",
      );
      state.dependentTicketID = await ticket(
        "Release version",
        `After the welcome dashboard delivers, set src/version.txt to exactly ${fixture.slug}-follow-on followed by a newline.`,
      );
      const prerequisites = await database.client<
        Array<{ prerequisite: string }>
      >`SELECT prerequisite_id AS prerequisite FROM factory.ticket_dependency WHERE ticket_id = ${state.dependentTicketID}`;
      if (!prerequisites.some((value) => value.prerequisite === state.ticketID))
        await page.getByLabel("Add prerequisite").selectOption(state.ticketID);
      await visible(page.getByRole("region", { name: "Prerequisites" })).toContainText(
        "Welcome dashboard",
      );
      await page.screenshot({ path: resolve(fixture.evidence, "dependencies-wide.png") });
      const knowledge = await eventually(
        async () => {
          const [generation] = await database.client<
            Array<{ state: string; count: number }>
          >`SELECT state, page_count AS count FROM factory.knowledge_generation WHERE project_id = ${project.id} ORDER BY created_at DESC LIMIT 1`;
          return generation;
        },
        (value) => value?.state === "succeeded" || value?.state === "failed",
        "Initial real Knowledge generation did not finish",
        180_000,
      );
      expect(knowledge?.state).toBe("succeeded");
      expect(knowledge?.count ?? 0).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Knowledge", exact: true }).click();
      await visible(page.locator(".knowledge-workspace")).toBeVisible();
      await page.screenshot({ path: resolve(fixture.evidence, "knowledge-wide.png") });
      await fixture.save("setup", performance.now() - started);
      console.info(
        "Release proof: actual UI registration, managed access/defaults/Skill, Knowledge and Zero Epic/dependency setup passed",
      );
    } catch (cause) {
      await fixture.capture(`${phase}-failure`);
      throw cause;
    } finally {
      await fixture.close();
    }
  },
  ["build", "inspection", "dependent"].includes(phase) ? 1_200_000 : 420_000,
);
