import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";

test.skipIf(process.env["FACTORY_REVIEW_UI_PROOF"] !== "1")(
  "independent review states remain compact, keyboard-readable and honest at desktop and narrow widths",
  async () => {
    const root = resolve(import.meta.dir, "../..");
    const directory = resolve(root, ".factory/test-results/reviewer-interface");
    const file = resolve(directory, "review.html");
    await Bun.write(
      file,
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><main id="root" style="max-width:52rem;margin:2rem auto;padding:24px"></main>
<script type="module">
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { TicketChecks } from "/apps/factory/src/ticket-checks.tsx";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "/apps/factory/src/tokens.css";
import "/apps/factory/src/style.css";
const [state,setState] = createSignal({
  building:true, unsubmitted:true,
  details:{verificationState:"succeeded",reviewState:"running",reviewCurrent:true}
});
window.setReview = setState;
render(() => <><h1>Review candidate</h1><TicketChecks details={state().details}
 building={state().building} preparing={state().preparing}
 unsubmitted={state().unsubmitted}/></>,document.getElementById("root"));
</script></body></html>`,
    );
    // Use the same Solid compiler and real component/CSS without rebuilding or
    // changing assets served by either retained Factory installation.
    const server = await createServer({
      configFile: false,
      root,
      plugins: [solid({ ssr: false })],
      server: { host: "127.0.0.1", port: 0 },
      cacheDir: resolve(directory, "vite-cache"),
      optimizeDeps: { include: ["solid-js", "@solidjs/web"] },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      if (!url) throw new Error("Owned UI listener missing");
      browser = await chromium.launch({
        headless: true,
        ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
          ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
          : {}),
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Vite transforms the fixture's inline JSX through a TSX entry.
      const entry = resolve(directory, "entry.tsx");
      const html = await Bun.file(file).text();
      const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
      if (!script) throw new Error("Missing UI fixture");
      await Bun.write(entry, script);
      await Bun.write(
        file,
        html.replace(
          /<script type="module">[\s\S]*?<\/script>/,
          '<script type="module" src="./entry.tsx"></script>',
        ),
      );
      await page.goto(new URL(".factory/test-results/reviewer-interface/review.html", url).href);
      const summary = page.locator(".ticket-checks > summary");
      await browserExpect(summary).toHaveText("Independent review in progress");
      await browserExpect(summary).toHaveCSS("font-family", /Inter Variable/);
      await browserExpect(
        page.getByText("Earlier check results do not approve these corrections."),
      ).toHaveCount(0);
      await summary.focus();
      await page.keyboard.press("Enter");
      await browserExpect(page.locator(".ticket-checks")).toHaveAttribute("open", "");
      await page.screenshot({ path: resolve(directory, "running-desktop.png") });
      for (const preparing of [true, false]) {
        await page.evaluate((value) => {
          (window as unknown as { setReview(value: unknown): void }).setReview({
            building: true,
            preparing: value,
            unsubmitted: false,
            details: {},
          });
        }, preparing);
        await browserExpect(summary).toHaveText(
          preparing ? "Preparing implementation" : "Implementation in progress",
        );
        await browserExpect(page.locator(".ticket-check-details")).toHaveText(
          preparing
            ? "Work starts automatically when preparation finishes. Your requirements and existing code are retained."
            : "The coding agent is implementing the approved requirements. Checks and independent review follow source submission.",
        );
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          await page.screenshot({
            path: resolve(directory, `${preparing ? "preparing" : "implementing"}-${width}.png`),
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
        }
      }
      await page.evaluate(() => {
        (window as unknown as { setReview(value: unknown): void }).setReview({
          building: true,
          preparing: true,
          unsubmitted: true,
          details: { verificationState: "succeeded", reviewState: "passed", reviewCurrent: false },
        });
      });
      await browserExpect(summary).toHaveText("Preparing implementation");
      await browserExpect(page.locator(".ticket-check-details")).toHaveText(
        "Earlier check results do not approve these corrections.",
      );
      await browserExpect(page.locator(".check-indicator.passed")).toHaveCount(0);
      const findings = [
        {
          severity: "blocking",
          title: "The empty search incorrectly keeps the previous results",
          explanation:
            "Clearing the query leaves the previous matches visible instead of restoring the full list.",
          path: "src/components/project-search/results-with-a-long-but-realistic-component-name.tsx",
          line: 42,
          reproduction:
            "Type 'invoice', wait for matches, then clear the field. Expected all projects; observed only invoice matches.",
        },
      ];
      const cases = [
        {
          name: "defects",
          label: "Review found defects",
          reviewState: "changes-requested",
          reviewSummary: "The search reset needs a correction.",
          reviewFindings: findings,
        },
        {
          name: "incomplete",
          label: "Independent review needs attention",
          reviewState: "incomplete",
          reviewSummary:
            "Mobile behavior could not be inspected. Retry the review after the declared App is available.",
          reviewFindings: [],
        },
        {
          name: "passed",
          label: "Checks and independent review passed",
          reviewState: "passed",
          reviewSummary:
            "The requested behavior and relevant UI states were independently inspected.",
          reviewFindings: [],
        },
      ];
      for (const scenario of cases) {
        await page.evaluate((value) => {
          (window as unknown as { setReview(value: unknown): void }).setReview({
            building: false,
            unsubmitted: false,
            details: { verificationState: "succeeded", reviewCurrent: true, ...value },
          });
        }, scenario);
        await browserExpect(summary).toHaveText(new RegExp(scenario.label));
        if (scenario.name === "defects") {
          const finding = page.locator(".ticket-check-details details summary");
          await finding.focus();
          await page.keyboard.press("Enter");
          await browserExpect(page.getByText(findings[0]!.explanation)).toBeVisible();
        }
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          await page.screenshot({ path: resolve(directory, `${scenario.name}-${width}.png`) });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  120_000,
);
