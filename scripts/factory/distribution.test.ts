import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import upstream from "../../upstream.json";
import { gateSteps } from "../release/beta-gate";

const publishedRuntimeRoles = [
  "runtime-host",
  "developer-ide",
  "browser-tools",
  "substrate-runtime",
  "starter-work",
  "starter-postgres",
] as const;

test("source-development Compose does not offer a second product installation", async () => {
  const compose = parse(
    await readFile(new URL("../../deploy/local/compose.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(compose.services)).toEqual(["postgres", "forgejo", "zero-cache"]);
  expect(JSON.stringify(compose)).not.toContain("docker.sock");
  expect(JSON.stringify(compose)).not.toContain("KUBECONFIG");
});

test("application build tools match the upstream artifact pins", async () => {
  const toolVersions = await readFile(new URL("../../mise.toml", import.meta.url), "utf8");
  expect(toolVersions).toContain(`kubectl = "${upstream.kubectl.version}"`);
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const image of [
    upstream.kubectl.image,
    upstream.openCodeServer.bunImage,
    upstream.nodeDevelopment.image,
  ])
    expect(dockerfile).toContain(image);
  expect(dockerfile).not.toContain("mkcert");
  expect(dockerfile).not.toContain("COPY --from=docker");
  expect(dockerfile).not.toContain("COPY deploy/local");
  expect(dockerfile).toContain('"/var/lib/factory/bootstrap.lock"');
  expect(dockerfile).toContain('"scripts/kubernetes/start.ts"');
  expect(dockerfile).toContain("scripts/factory/native-installation.ts");
  expect(dockerfile).toContain(`ARG SQLITE_SOURCE=${upstream.sqlite.source}`);
  expect(dockerfile).toContain(`ARG SQLITE_SHA256=${upstream.sqlite.sha256}`);
  expect(dockerfile).toContain(
    "COPY --from=sqlite-tools /factory-sqlite /usr/local/bin/factory-sqlite",
  );
  const sqliteBuild = await readFile(new URL("./build-sqlite.sh", import.meta.url), "utf8");
  expect(sqliteBuild).toContain("sha256sum -c -");
  expect(sqliteBuild).toContain("-static");
  expect(sqliteBuild).toContain("-DSQLITE_OMIT_LOAD_EXTENSION");
  const smoke = await readFile(new URL("./image-smoke.ts", import.meta.url), "utf8");
  expect(smoke).toContain('await import(resolve(root, "scripts/factory/native-installation.ts"))');
  expect(smoke).toContain('await import(resolve(root, "scripts/kubernetes/preflight.ts"))');
  expect(smoke).toContain('Bun.spawn([process.execPath, "scripts/kubernetes/start.ts"]');
  expect(smoke).toContain("Configure FACTORY_STATE_DIRECTORY before Kubernetes startup");
});

test("only published releases build and publish arm64 and amd64 natively", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(workflow.on).sort()).toEqual(["release", "workflow_dispatch"]);
  expect(workflow.on.release).toEqual({ types: ["published"] });
  expect(workflow.on.workflow_dispatch.inputs.release_tag.required).toBe(true);
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const validate = workflow.jobs.release.steps.find(
    (step: { id?: string }) => step.id === "version",
  );
  expect(validate.env.RELEASE_TAG).toBe(
    "${{ github.event.release.tag_name || inputs.release_tag }}",
  );
  expect(workflow.jobs.verify.with.source_ref).toBe(validate.env.RELEASE_TAG);
  for (const job of ["release", "roles", "manifests", "factory", "distribution", "chart"])
    expect(workflow.jobs[job].steps[0].with.ref).toBe(validate.env.RELEASE_TAG);
  expect(validate.run).toContain(`version="\${RELEASE_TAG#v}"`);
  expect(validate.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(workflow.jobs.roles.needs).toEqual(["release", "verify"]);
  expect(workflow.jobs.distribution.needs).toEqual(["release", "factory"]);
  for (const job of ["roles", "factory"])
    expect(workflow.jobs[job].strategy.matrix.include).toEqual([
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
      { arch: "amd64", runner: "ubuntu-24.04" },
    ]);
  for (const job of ["roles", "factory"]) {
    const build = workflow.jobs[job].steps.find((step: { run?: string }) =>
      step.run?.includes("docker buildx build"),
    );
    expect(build.run).toContain(
      '--label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY"',
    );
    expect(build.run).toContain('--label "org.opencontainers.image.revision=$REVISION"');
    expect(build.run).toContain('--label "org.opencontainers.image.version=$RELEASE"');
  }
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].env.RELEASE).toBe(`\${{ needs.release.outputs.version }}`);
  expect(JSON.stringify(workflow)).not.toContain("setup-qemu");
  expect(workflow.jobs.factory.needs).toContain("manifests");
  expect(workflow.jobs.manifests.needs).toContain("roles");
});

test("release images require full source checks or a validated exact-commit local gate", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.jobs.verify.needs).toBe("release");
  expect(workflow.jobs.verify.if).toBe(`\${{ needs.release.outputs.local_gate_passed != 'true' }}`);
  expect(workflow.jobs.verify.uses).toBe("./.github/workflows/checks.yaml");
  expect(workflow.jobs.verify["continue-on-error"]).not.toBe(true);
  expect(workflow.jobs.roles.needs).toContain("verify");
  expect(workflow.jobs.roles.if).toBe(
    `\${{ !cancelled() && needs.release.result == 'success' && (needs.verify.result == 'success' || needs.release.outputs.local_gate_passed == 'true') }}`,
  );
  const checks = parse(
    await readFile(new URL("../../.github/workflows/checks.yaml", import.meta.url), "utf8"),
  );
  // Releases call these lanes; nothing runs per push. `bun run beta:gate` judges each commit locally.
  expect(Object.keys(checks.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  expect(checks.permissions).toEqual({ contents: "read" });
  const verify = checks.jobs.verify;
  expect(verify.strategy["fail-fast"]).toBe(false);
  expect(verify.strategy.matrix.include).toEqual([{ arch: "arm64", runner: "ubuntu-24.04-arm" }]);
  expect(verify["runs-on"]).toBe(`\${{ matrix.runner }}`);
  expect(verify["continue-on-error"]).not.toBe(true);
  const chartCheck = verify.steps.find((step: { run?: string }) => step.run?.includes("helm lint"));
  expect(chartCheck.run).toContain("substrate.workspaceConfigurationSecret=native-workspaces");
  expect(chartCheck.run).toContain("substrate.provisionerTokenSecret=native-provisioner");
  expect(chartCheck.run).toContain("forgejoPublicURL=https://git.factory.test");
  expect(chartCheck.run).not.toContain("factorybox.");
  const steps = verify.steps as {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: string;
    "continue-on-error"?: boolean;
  }[];
  for (const step of steps) {
    if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
    expect(step["continue-on-error"]).not.toBe(true);
    expect(step.if).toBeUndefined();
  }
  expect(steps.find((step) => step.uses?.startsWith("jdx/mise-action@"))?.with).toEqual({
    version: "2026.10.3",
  });
  expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual({
    "persist-credentials": false,
    ref: "${{ inputs.source_ref || github.ref }}",
  });
  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(commands).toContain("mise exec -- bun install --frozen-lockfile");
  expect(commands).toContain(
    "mise exec -- bun --bun ./node_modules/@playwright/test/cli.js install --with-deps chromium",
  );
  expect(commands).toContain("mise exec -- mkcert -install");
  expect(commands).toContain(
    "mise exec -- bun run test:controllers /planning-cache-network.test.ts",
  );
  expect(commands).toContain("mise exec -- bun run check:integration");
  expect(commands).toContain("mise exec -- bun run test:browser");
  expect(commands.some((command) => command.includes("upstream.json"))).toBe(true);
  expect(steps.find((step) => step.uses?.startsWith("actions/setup-go@"))?.with).toEqual({
    "go-version": `\${{ steps.tools.outputs.go }}`,
    "cache-dependency-path": "services/runtime-connector/go.sum",
  });
  expect(JSON.stringify(checks)).not.toMatch(/secrets\.|test:(?:live|native|browser:paid)/);
});

test("local gate reuse rejects another commit, incomplete checks and failed receipts", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.on.workflow_dispatch.inputs.use_local_gate).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(workflow.jobs.release.outputs.local_gate_passed).toBe(
    `\${{ steps.local-gate.outputs.passed }}`,
  );
  const gate = workflow.jobs.release.steps.find(
    (step: { id?: string }) => step.id === "local-gate",
  );
  const revision = "a".repeat(40);
  const complete = {
    schema: 1,
    scope: "source-controller-ui",
    nativeProductAcceptance: false,
    commit: revision,
    passed: true,
    steps: [
      "clean-tree",
      "forbidden-terms",
      "secrets",
      ...gateSteps().map((step) => step.name),
    ].map((name) => ({ name, passed: true })),
  };
  const incomplete = structuredClone(complete);
  incomplete.steps.pop();
  const missingSubstrate = {
    ...complete,
    steps: complete.steps.filter((step) => step.name !== "substrate"),
  };
  const failed = structuredClone(complete);
  failed.steps[0]!.passed = false;
  const duplicate = structuredClone(complete);
  duplicate.steps[0]!.name = "browser";
  const directory = await mkdtemp(join(tmpdir(), "factory-local-release-gate-"));
  try {
    for (const [receipt, enabled, expected] of [
      [complete, "true", 0],
      [{ ...complete, commit: "b".repeat(40) }, "true", 1],
      [{ ...complete, passed: false }, "true", 1],
      [{ ...complete, schema: 2 }, "true", 1],
      [{ ...complete, scope: "native-product-acceptance" }, "true", 1],
      [{ ...complete, nativeProductAcceptance: true }, "true", 1],
      [incomplete, "true", 1],
      [missingSubstrate, "true", 1],
      [failed, "true", 1],
      [duplicate, "true", 1],
      [complete, "false", 0],
    ] as const) {
      const fixture = join(directory, "fixture.json");
      const output = join(directory, "output.txt");
      await writeFile(fixture, JSON.stringify(receipt));
      await writeFile(output, "");
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          `
        git() { printf '%s\\n' "$EXPECTED_REVISION"; }
        curl() { test "$USE_LOCAL_GATE" = true; cp "$RECEIPT_FIXTURE" "\${!#}"; }
        ${gate.run}
      `,
        ],
        {
          env: {
            ...process.env,
            USE_LOCAL_GATE: enabled,
            EXPECTED_REVISION: revision,
            RECEIPT_FIXTURE: fixture,
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: directory,
            GITHUB_REPOSITORY: "maxcodefaster/open-software-factory",
            RELEASE_TAG: "v0.1.0-beta.1",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(expected);
      expect(await readFile(output, "utf8")).toBe(expected === 0 ? `passed=${enabled}\n` : "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime publication compares config digests, not Docker's manifest ID", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  expect(command).toContain('--metadata-file "$RUNNER_TEMP/$role-proven.json"');
  expect(command).toContain('docker image save --output "$proof_archive" "$image_id"');
  expect(command).toContain('tar -xOf "$proof_archive" -- "$config_file" | sha256sum');
  expect(command).not.toContain("containerimage.config.digest");
  expect(command).toContain('docker buildx imagetools inspect "$image@$native_child" --raw');
  expect(command).toContain(
    'test "$(docker image inspect --format \'{{.Id}}\' "$image")" = "$image_id"',
  );
  expect(command).toContain('elif [[ "$role" == developer-ide ]]');
  expect(command).toContain("--read-only --cap-drop=ALL --user 1000:1000");
  expect(command).toContain('fs.readFileSync("/opt/factory/theia/package.json", "utf8")');
  expect(command).toContain('fs.readdirSync("/opt/factory/theia"');
  const comparison = command.split("\n").find((line) => line.includes('test "$published_config"'));
  if (!comparison) throw new Error("Missing published config comparison");
  const configDigest = `sha256:${"a".repeat(64)}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  for (const [pushed, expected] of [
    [configDigest, 0],
    [manifestDigest, 1],
  ] as const) {
    const child = Bun.spawn(["bash", "-c", comparison], {
      env: {
        ...process.env,
        proven_config: configDigest,
        published_config: pushed,
        image_id: manifestDigest,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(expected);
  }
});

test("native Actor publication uses only same-architecture tools, proves the direct image and combines the artifact", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const build: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  expect(build).toContain(`for role in ${publishedRuntimeRoles.join(" ")}; do`);
  expect(build).not.toContain("workspace-files");
  expect(build).not.toContain('[[ "$role" == substrate-* && "$ARCH" != amd64 ]]');
  expect(JSON.stringify(workflow)).not.toMatch(
    /substrate-bootstrap|SUBSTRATE_BOOTSTRAP_IMAGE|substrate\/rootless/,
  );
  expect(build).toContain("dockerfile=deploy/substrate/Runtime.Dockerfile");
  expect(build).toContain('release_require_revision "$tools" "$REVISION"');
  expect(build).toContain('tools="$IMAGE_ROOT/runtime-host:$RELEASE-$ARCH"');
  expect(build).toContain(
    'FACTORY_RUNTIME_HOST_IMAGE=$IMAGE_ROOT/runtime-host@$(release_digest "$tools")',
  );
  expect(build).toContain('bash scripts/runtime/substrate-image-proof.sh "$image_id"');
  const manifest: string = workflow.jobs.manifests.steps.find(
    (step: { id?: string }) => step.id === "publish",
  ).run;
  expect(manifest).toContain(`for role in ${publishedRuntimeRoles.join(" ")}; do`);
  expect(manifest).toContain('release_combine "$image" "$image-arm64" "$image-amd64"');
  expect(manifest).toContain('release_require_revision "$image-$arch" "$(git rev-parse HEAD)"');
  expect(manifest).not.toContain('image="$IMAGE_ROOT/substrate-runtime:$RELEASE-amd64"');
  expect(manifest).not.toContain("workspace-files");
  expect(workflow.jobs.chart.needs).toContain("manifests");
  expect(workflow.jobs.chart.env.RUNTIME_ARTIFACTS).toBe(
    `\${{ needs.manifests.outputs.artifacts }}`,
  );
  const packaging: string = workflow.jobs.chart.steps.find((step: { run?: string }) =>
    step.run?.includes("package-chart.ts"),
  ).run;
  expect(packaging).toContain('--artifacts "$RUNNER_TEMP/runtime-artifacts.json"');
  expect(packaging).not.toContain("factorybox");
  expect(workflow.jobs.chart.steps.at(-1).run).toContain("factory-runtime-artifacts-$RELEASE.json");
});

test("Starter roles use their existing Dockerfiles and common native revision/SBOM build arguments", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  const start = command.indexOf("dockerfile=deploy/runtime-host/Dockerfile");
  const end = command.indexOf('\n    if [[ "$role" == runtime-host', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const declaration = command.slice(start, end);
  for (const architecture of ["arm64", "amd64"]) {
    for (const recipe of ["work", "postgres"]) {
      const role = `starter-${recipe}`;
      const dockerfile = `templates/starter-app/.factory/images/${recipe}/Dockerfile`;
      expect(await Bun.file(new URL(`../../${dockerfile}`, import.meta.url)).exists()).toBe(true);
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          `set -eo pipefail
# The CI jobs use modern Linux Bash; macOS Bash 3 rejects its empty arrays under nounset.
release_require_revision() { exit 91; }
release_digest() { exit 92; }
${declaration}
printf '%s\\0' "\${build[@]}" "\${attest[@]}"
`,
        ],
        {
          env: {
            ...process.env,
            role,
            ARCH: architecture,
            REVISION: "owned-revision",
            RELEASE: "0.1.0-proof",
            GITHUB_REPOSITORY: "owned/factory",
            image: `registry.test/factory/${role}:0.1.0-proof-${architecture}`,
            SBOM_GENERATOR: workflow.env.SBOM_GENERATOR,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, error).toBe(0);
      expect(output.split("\0").filter(Boolean)).toEqual([
        "docker",
        "buildx",
        "build",
        "--platform",
        `linux/${architecture}`,
        "--label",
        "org.opencontainers.image.source=https://github.com/owned/factory",
        "--label",
        "org.opencontainers.image.revision=owned-revision",
        "--label",
        "org.opencontainers.image.version=0.1.0-proof",
        "--file",
        dockerfile,
        "--tag",
        `registry.test/factory/${role}:0.1.0-proof-${architecture}`,
        "--provenance=mode=max",
        `--sbom=generator=${workflow.env.SBOM_GENERATOR}`,
      ]);
    }
  }
  expect(command).toContain(`"\${build[@]}" "\${attest[@]}" --push .`);
  expect(command).toContain('release_require_revision "$image" "$REVISION"');
  expect(command).toContain('release_sign "$IMAGE_ROOT/$role@$digest"');
  expect(workflow.jobs.roles.needs).toEqual(["release", "verify"]);
});

test("runtime and Starter publication prove the loaded native config and refuse proof or config failure before signing", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  const declarationStart = command.indexOf("dockerfile=deploy/runtime-host/Dockerfile");
  const branchStart = command.indexOf('if [[ "$role" == runtime-host ||', declarationStart);
  const branchEnd = command.indexOf("\n  fi\n  digest=", branchStart);
  expect(declarationStart).toBeGreaterThan(0);
  expect(branchStart).toBeGreaterThan(declarationStart);
  expect(branchEnd).toBeGreaterThan(branchStart);
  const signingStart = command.indexOf('digest="$(release_digest', branchEnd);
  const signingEnd = command.lastIndexOf("\ndone");
  expect(signingStart).toBeGreaterThan(branchEnd);
  expect(signingEnd).toBeGreaterThan(signingStart);
  const signing = command.slice(signingStart, signingEnd);
  const directory = await mkdtemp(join(tmpdir(), "factory-runtime-proven-config-"));
  const calls = join(directory, "calls");
  const imageID = `sha256:${"b".repeat(64)}`;
  const config = '{"owned":"configuration actually loaded for proof"}';
  const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
  try {
    for (const architecture of ["arm64", "amd64"]) {
      for (const role of [
        "runtime-host",
        "substrate-runtime",
        "starter-work",
        "starter-postgres",
      ]) {
        const proofCommand = role.startsWith("starter-")
          ? `scripts/runtime/starter-image-proof.sh ${imageID} ${role}`
          : `scripts/runtime/substrate-image-proof.sh ${imageID}`;
        for (const failure of ["", "proof", "config"]) {
          await writeFile(calls, "");
          const child = Bun.spawn(
            [
              "bash",
              "-c",
              `set -eo pipefail
docker() {
  printf 'docker|%s\\n' "$*" >> "$OWNED_CALLS"
  if [[ "$1 $2" == "image inspect" ]]; then printf '%s\\n' "$OWNED_IMAGE_ID"
  elif [[ "$1 $2" == "image save" ]]; then : > "$4"
  elif [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
    if [[ "$4" == *"@"* ]]; then
      printf '{"config":{"digest":"%s"}}\\n' "$OWNED_PUBLISHED_CONFIG"
    else
      printf '{"manifests":[{"platform":{"os":"linux","architecture":"%s"},"digest":"%s"}]}\\n' "$ARCH" "$OWNED_IMAGE_ID"
    fi
  else test "$1 $2" = "buildx build"; fi
}
tar() {
  if [[ "\${!#}" == manifest.json ]]; then printf '[{"Config":"owned-config.json"}]\\n'
  else test "\${!#}" = owned-config.json && printf '%s' "$OWNED_CONFIG"; fi
}
bash() {
  printf 'proof|%s\\n' "$*" >> "$OWNED_CALLS"
  test "$*" = "$OWNED_PROOF"
  test "$OWNED_FAILURE" != proof
}
release_require_revision() { test "$1" = "$IMAGE_ROOT/runtime-host:$RELEASE-$ARCH" && test "$2" = "$REVISION"; }
release_digest() { printf '%s\\n' "$OWNED_IMAGE_ID"; }
release_sign() { printf 'sign|%s\\n' "$*" >> "$OWNED_CALLS"; }
${command.slice(declarationStart, branchEnd)}
${signing}
`,
            ],
            {
              env: {
                ...process.env,
                role,
                ARCH: architecture,
                REVISION: "owned-revision",
                RELEASE: "0.1.0-proof",
                IMAGE_ROOT: "registry.test/owned/factory",
                GITHUB_REPOSITORY: "owned/factory",
                image: `registry.test/owned/factory/${role}:0.1.0-proof-${architecture}`,
                SBOM_GENERATOR: workflow.env.SBOM_GENERATOR,
                RUNNER_TEMP: directory,
                OWNED_CALLS: calls,
                OWNED_IMAGE_ID: imageID,
                OWNED_CONFIG: config,
                OWNED_PUBLISHED_CONFIG: failure === "config" ? imageID : configDigest,
                OWNED_FAILURE: failure,
                OWNED_PROOF: proofCommand,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [code, , error] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, error).toBe(failure ? 1 : 0);
          const observed = await readFile(calls, "utf8");
          const proof = `proof|${proofCommand}`;
          expect(observed).toContain("--load");
          expect(observed).toContain(proof);
          expect(observed.indexOf("--load")).toBeLessThan(observed.indexOf(proof));
          if (failure === "proof") expect(observed).not.toContain("--push");
          else {
            expect(observed).toContain("--provenance=mode=max");
            expect(observed).toContain(`--sbom=generator=${workflow.env.SBOM_GENERATOR}`);
            expect(observed).toContain("--push --metadata-file");
            expect(observed.indexOf(proof)).toBeLessThan(observed.indexOf("--push"));
          }
          expect(observed.includes("sign|")).toBe(failure === "");
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the signed six-role manifest reaches Factory unchanged and refuses either Starter's wrong architecture revision", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.manifests.steps.find(
    (step: { id?: string }) => step.id === "publish",
  ).run;
  const start = command.indexOf("artifacts='{}'");
  expect(start).toBeGreaterThan(0);
  const directory = await mkdtemp(join(tmpdir(), "factory-six-role-manifest-"));
  const digest = `sha256:${"c".repeat(64)}`;
  const imageRoot = "registry.test/owned/factory";
  const release = "0.1.0-proof";
  try {
    const library = join(directory, "release-lib.sh");
    const output = join(directory, "output");
    const calls = join(directory, "calls");
    await writeFile(
      library,
      `release_require_revision() {
  printf 'revision|%s|%s\\n' "$1" "$2" >> "$OWNED_CALLS"
  test "$2" = owned-revision && test "$1" != "$REJECT_REF"
}
release_combine() {
  printf 'combine|%s|%s|%s\\n' "$1" "$2" "$3" >> "$OWNED_CALLS"
  printf '%s\\n' "$OWNED_DIGEST"
}
release_sign() { printf 'sign|%s\\n' "$1" >> "$OWNED_CALLS"; }
`,
    );
    for (const reject of [
      "",
      ...["starter-work", "starter-postgres"].flatMap((role) =>
        ["arm64", "amd64"].map((arch) => `${imageRoot}/${role}:${release}-${arch}`),
      ),
    ]) {
      await writeFile(output, "");
      await writeFile(calls, "");
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          `set -euo pipefail
source "$OWNED_LIBRARY"
git() { printf 'owned-revision\\n'; }
${command.slice(start)}
`,
        ],
        {
          env: {
            ...process.env,
            OWNED_LIBRARY: library,
            OWNED_CALLS: calls,
            OWNED_DIGEST: digest,
            REJECT_REF: reject,
            IMAGE_ROOT: imageRoot,
            RELEASE: release,
            GITHUB_ACTOR: "owned-user",
            GHCR_TOKEN: "owned-unused-token",
            GITHUB_OUTPUT: output,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, , error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, error).toBe(reject ? 1 : 0);
      const result = await readFile(output, "utf8");
      if (reject) {
        expect(result).toBe("");
        continue;
      }
      expect(JSON.parse(result.trim().replace(/^artifacts=/, ""))).toEqual(
        Object.fromEntries(
          publishedRuntimeRoles.map((role) => [role, `${imageRoot}/${role}@${digest}`]),
        ),
      );
      const events = (await readFile(calls, "utf8")).trim().split("\n");
      expect(events).toHaveLength(publishedRuntimeRoles.length * 4);
      for (const role of publishedRuntimeRoles) {
        const image = `${imageRoot}/${role}:${release}`;
        expect(events).toContain(`revision|${image}-arm64|owned-revision`);
        expect(events).toContain(`revision|${image}-amd64|owned-revision`);
        expect(events).toContain(`combine|${image}|${image}-arm64|${image}-amd64`);
        expect(events).toContain(`sign|${imageRoot}/${role}@${digest}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const factory = workflow.jobs.factory.steps.find((step: { id?: string }) => step.id === "build");
  expect(factory.env.FACTORY_RUNTIME_ARTIFACTS).toBe(`\${{ needs.manifests.outputs.artifacts }}`);
  expect(factory.run).toContain(
    "--file deploy/factory/Dockerfile --build-arg FACTORY_RUNTIME_ARTIFACTS",
  );
  expect(factory.run).not.toContain("FACTORY_STARTER_IMAGES");
});

test("Kubernetes planning replicas use the observed namespace epoch without changing retained authority", async () => {
  const startup = await readFile(new URL("../kubernetes/start.ts", import.meta.url), "utf8");
  expect(startup).toContain(
    'execute(["get", "namespace", namespace, "-o", "jsonpath={.metadata.uid}"])',
  );
  expect(startup).toContain("FACTORY_PLANNING_CACHE_EPOCH: planningCacheEpoch");
  expect(startup.indexOf("const planningCacheEpoch")).toBeLessThan(
    startup.indexOf("const child = Bun.spawn"),
  );
  const serverConfig = await readFile(
    new URL("../../apps/factory/src/server/config.ts", import.meta.url),
    "utf8",
  );
  expect(serverConfig).toContain('env["FACTORY_PLANNING_CACHE_EPOCH"]');
  const application = await readFile(
    new URL("../../apps/factory/src/server/application.ts", import.meta.url),
    "utf8",
  );
  expect(application).toContain("planningCacheEpoch: config.planningCacheEpoch");
});

test("native startup uses the same artifact environment and checks storage with tool-image shell only", async () => {
  for (const file of ["./index.ts", "../kubernetes/start.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    expect(source).toMatch(
      /runtimeArtifactEnvironment\(\s*artifacts,\s*nativeRuntimeArchitecture\(/,
    );
    expect(source).toContain('image: artifacts["runtime-host"]');
    expect(source).not.toContain("workspace-files");
    expect(source).not.toContain("FACTORY_WORKSPACE_FILES_IMAGE");
  }
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  expect(dockerfile).toContain("AS source-service");
  expect(dockerfile).toContain("go build -mod=readonly -trimpath");
  expect(dockerfile).toContain(
    "COPY --from=source-service /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
  const storage = await readFile(new URL("./storage-readiness.ts", import.meta.url), "utf8");
  expect(storage).toContain("runAsUser: 1000");
  expect(storage).toContain('"/bin/sh"');
  expect(storage).toContain("sync -d /data/factory-storage-check");
  expect(storage).not.toContain("factory-workspace-files");
  expect(
    await Bun.file(new URL("../../deploy/workspace-files/Dockerfile", import.meta.url)).exists(),
  ).toBe(false);
  expect(
    await Bun.file(
      new URL(
        "../../services/runtime-connector/cmd/factory-workspace-files/main_linux.go",
        import.meta.url,
      ),
    ).exists(),
  ).toBe(false);
});

test("published config lookup selects one native child and ignores attestations", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  const filter = /native_child=.*jq -er --arg arch "\$ARCH" '([^']+)'/.exec(command)?.[1];
  expect(filter).toBeDefined();
  const arm = {
    digest: `sha256:${"a".repeat(64)}`,
    platform: { os: "linux", architecture: "arm64" },
  };
  const amd = {
    digest: `sha256:${"b".repeat(64)}`,
    platform: { os: "linux", architecture: "amd64" },
  };
  const attestation = {
    digest: `sha256:${"c".repeat(64)}`,
    platform: { os: "unknown", architecture: "unknown" },
  };
  for (const [manifests, architecture, expected, digest] of [
    [[arm, amd, attestation], "arm64", 0, arm.digest],
    [[arm, amd, attestation], "amd64", 0, amd.digest],
    [[arm, attestation], "amd64", 5, ""],
    [[arm, arm, attestation], "arm64", 5, ""],
  ] as const) {
    const child = Bun.spawn(["jq", "-er", "--arg", "arch", architecture, filter ?? ""], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ manifests }));
    child.stdin.end();
    expect(await child.exited).toBe(expected);
    expect((await new Response(child.stdout).text()).trim()).toBe(digest);
  }
});

test("release publication is attested, signed and scoped to the jobs that need credentials", async () => {
  const text = await readFile(
    new URL("../../.github/workflows/images.yaml", import.meta.url),
    "utf8",
  );
  const workflow = parse(text);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
  for (const job of ["release", "verify"])
    expect(workflow.jobs[job].permissions?.packages).toBeUndefined();
  expect(text).not.toContain('--provenance=false"');
  expect(text).toContain("--provenance=mode=max");
  expect(text).toContain("--sbom=generator=$SBOM_GENERATOR");
  expect(workflow.env.BUILDKIT_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(text).toContain('--driver-opt "image=$BUILDKIT_IMAGE"');
  expect(text).not.toMatch(/docker buildx create --use$/m);
  for (const job of Object.values(workflow.jobs) as {
    steps?: { uses?: string; with?: Record<string, unknown> }[];
  }[])
    for (const step of job.steps ?? []) {
      if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@"))
        expect(step.with?.["persist-credentials"]).toBe(false);
    }
  const factory = workflow.jobs.factory.steps as {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  }[];
  const scan = factory.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  expect(scan?.with).toMatchObject({
    severity: "CRITICAL",
    "ignore-unfixed": true,
    "exit-code": 1,
  });
  expect(factory.findIndex((step) => step.run?.includes("image-smoke.ts"))).toBeGreaterThan(
    factory.findIndex((step) => step.run?.includes("docker buildx build")),
  );
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain("GITHUB_STEP_SUMMARY");
  expect(workflow.jobs.distribution.outputs.factory).toBe("${{ steps.publish.outputs.factory }}");
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain("printf 'factory=%s@%s\\n'");
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain('>> "$GITHUB_OUTPUT"');
  expect(workflow.jobs.chart.env.FACTORY_IMAGE).toBe("${{ needs.distribution.outputs.factory }}");
  const library = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");
  expect(library).toContain("Choose a new release version.");
  expect(library).toContain("cosign sign --yes");
});

test("every publication job installs the same digest-pinned Cosign binary", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.env.COSIGN_IMAGE).toMatch(/:v2\.5\.3@sha256:[a-f0-9]{64}$/);
  const scripts = ["roles", "manifests", "factory", "distribution", "chart"].map(
    (job) =>
      workflow.jobs[job].steps.find(
        (step: { name?: string }) => step.name === "Install pinned Cosign",
      ).run,
  );
  expect(new Set(scripts).size).toBe(1);
  expect(scripts[0]).toContain('docker pull "$COSIGN_IMAGE"');
  expect(scripts[0]).toContain('docker create --network=none "$COSIGN_IMAGE"');
  expect(scripts[0]).toContain(".Config.Entrypoint");
  expect(scripts[0]).toContain('.gitVersion == "v2.5.3"');
  expect(scripts[0]).toContain("GITHUB_PATH");
  const syntax = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  syntax.stdin.write(scripts[0]);
  syntax.stdin.end();
  expect(await syntax.exited).toBe(0);
});

test("fixed upstream transport proof and vulnerability scan precede image signing", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs.factory.steps;
  const proof = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("/proof/framework-image-proof.ts"),
  );
  const scan = steps.findIndex((step: { uses?: string }) =>
    step.uses?.startsWith("aquasecurity/trivy-action@"),
  );
  const sign = steps.findIndex((step: { run?: string }) =>
    step.run?.includes('release_sign "$IMAGE_REF"'),
  );
  expect(proof).toBeGreaterThan(0);
  expect(scan).toBeGreaterThan(proof);
  expect(sign).toBeGreaterThan(scan);
  expect(steps[proof].env.IMAGE_REF).toBe(`\${{ steps.build.outputs.ref }}`);
  expect(steps[proof].run).toContain("--network=none --read-only --cap-drop=ALL --user 1000:1000");
  expect(steps[proof].run).toContain('> "$RUNNER_TEMP/framework-security-proof.json"');
  expect(steps[scan].env.TRIVY_VEX).toBeUndefined();
  expect(steps[scan].env.TRIVY_PLATFORM).toBe(`linux/\${{ matrix.arch }}`);
  expect(steps[scan].with["exit-code"]).toBe(1);
  expect(steps[scan]["continue-on-error"]).not.toBe(true);
  expect(steps[sign].run).not.toContain("openvex");
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const stage of ["build", "dependencies"]) {
    const commands = dockerfile.split(`FROM tools AS ${stage}\n`)[1]?.split("\nFROM ")[0];
    expect(commands).toBeDefined();
    expect(commands?.indexOf("COPY package.json bun.lock")).toBeLessThan(
      commands?.indexOf("RUN bun install") ?? -1,
    );
  }
});

test("only explicit owner-authorized beta.1 correction can overwrite published tags", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.on.workflow_dispatch.inputs.overwrite_existing).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(workflow.env.RELEASE_OVERWRITE).toBe(`\${{ inputs.overwrite_existing || 'false' }}`);
  expect(
    workflow.jobs.release.steps.find((step: { id?: string }) => step.id === "version").run,
  ).toContain('test "$RELEASE_TAG" = v0.1.0-beta.1');
  const library = new URL("./release-lib.sh", import.meta.url).pathname;
  for (const [version, flag, expected] of [
    ["0.1.0-beta.1", "false", 1],
    ["0.1.0-beta.1", "true", 0],
    ["0.1.0-beta.2", "true", 1],
    ["0.1.0", "true", 1],
    ["0.1.0-beta.1", "1", 1],
  ] as const) {
    const child = Bun.spawn(["bash", "-c", 'source "$1"; release_overwrite', "proof", library], {
      env: { ...process.env, RELEASE: version, RELEASE_OVERWRITE: flag },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(expected);
  }
  for (const job of ["roles", "factory"]) {
    const command = workflow.jobs[job].steps.find((step: { run?: string }) =>
      step.run?.includes("docker buildx build"),
    ).run;
    expect(command).toContain(
      'release_exists "$IMAGE_ROOT/factory:$RELEASE" && ! release_overwrite',
    );
    expect(command).toContain('if [[ "$reuse" == true ]]');
    expect(command).toContain("cosign verify --certificate-identity-regexp");
  }
});

test("chart signing authenticates Cosign as well as Helm", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.chart.steps.at(-1).run as string;
  expect(command).toContain(
    'helm registry login ghcr.io --username "$GITHUB_ACTOR" --password-stdin',
  );
  expect(command).toContain('docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin');
  expect(command.indexOf("docker login")).toBeLessThan(command.indexOf("cosign sign"));
});

test("cached Factory images must carry the exact released runtime references", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.factory.steps.find((step: { id?: string }) => step.id === "build")
    .run as string;
  const script = /'(const ordered=.*?)'; then/.exec(command)?.[1];
  expect(script).toBeDefined();
  const directory = await mkdtemp(join(tmpdir(), "factory-runtime-references-"));
  const artifacts = { "runtime-host": "host-image", "developer-ide": "ide-image" };
  try {
    await writeFile(join(directory, "runtime-artifacts.json"), JSON.stringify(artifacts));
    for (const [expected, exitCode] of [
      [{ "developer-ide": "ide-image", "runtime-host": "host-image" }, 0],
      [{ ...artifacts, "runtime-host": "changed-image" }, 1],
      [{ "runtime-host": "host-image" }, 1],
    ] as const) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script ?? ""], {
        cwd: directory,
        env: { ...process.env, EXPECTED_RUNTIME_ARTIFACTS: JSON.stringify(expected) },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(exitCode);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("published image jobs survive a locally satisfied verification dependency but not failures", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  for (const [job, dependency] of [
    ["manifests", "roles"],
    ["factory", "manifests"],
    ["distribution", "factory"],
  ] as const) {
    expect(workflow.jobs[job].needs).toEqual(["release", dependency]);
    expect(workflow.jobs[job].if).toBe(
      `\${{ !cancelled() && needs.release.result == 'success' && needs.${dependency}.result == 'success' }}`,
    );
  }
  expect(workflow.jobs.chart.needs).toEqual(["release", "distribution", "manifests"]);
  expect(workflow.jobs.chart.if).toBe(
    `\${{ !cancelled() && needs.release.result == 'success' && needs.distribution.result == 'success' && needs.manifests.result == 'success' }}`,
  );
});

test("an overwrite reuses only signed runtime images from the exact release commit", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run as string;
  const start = command.indexOf("reuse=false");
  const end = command.indexOf('if [[ "$reuse" == true ]]', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = command.slice(start, end);
  for (const [found, signed, overwrite, expectedCode, expectedReuse] of [
    ["release-commit", "true", "true", 0, "true"],
    ["release-commit", "false", "true", 0, "false"],
    ["other-commit", "true", "true", 0, "false"],
    ["release-commit", "false", "false", 0, "true"],
    ["other-commit", "true", "false", 1, ""],
  ] as const) {
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `
      set -euo pipefail
      release_exists() { return 0; }
      release_overwrite() { test "$OVERWRITE" = true; }
      release_revision() { printf '%s' "$FOUND"; }
      release_require_revision() { test "$FOUND" = "$REVISION"; }
      release_digest() { printf 'sha256:%064d' 0; }
      cosign() { test "$SIGNED" = true; }
      ${block}
      printf '%s' "$reuse"
    `,
      ],
      {
        env: {
          ...process.env,
          FOUND: found,
          SIGNED: signed,
          OVERWRITE: overwrite,
          REVISION: "release-commit",
          GITHUB_REPOSITORY: "maxcodefaster/open-software-factory",
          IMAGE_ROOT: "ghcr.io/maxcodefaster/open-software-factory",
          role: "runtime-host",
          image: "fixture:release",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(expectedCode);
    expect(await new Response(child.stdout).text()).toBe(expectedReuse);
  }
});

test("the native lane is a separate manual workflow that never runs for pull requests", async () => {
  const native = parse(
    await readFile(new URL("../../.github/workflows/native.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(native.on)).toEqual(["workflow_dispatch"]);
  expect(native.jobs.native["runs-on"]).toEqual(["self-hosted", "linux", "x64", "substrate"]);
  expect(native.name).toBe("Native Substrate lane");
  const commands = native.jobs.native.steps.flatMap((step: { run?: string }) =>
    step.run ? [step.run] : [],
  );
  expect(commands).toContain("mise exec -- bun run test:native");
  expect(commands.join("\n")).not.toContain("runtime:conformance");
  const images = await readFile(
    new URL("../../.github/workflows/images.yaml", import.meta.url),
    "utf8",
  );
  expect(images).not.toMatch(/test:(?:live|native|browser:paid)|runtime:conformance/);
});

test("the pull request checks build the Factory image so a broken COPY fails before release", async () => {
  const checks = parse(
    await readFile(new URL("../../.github/workflows/checks.yaml", import.meta.url), "utf8"),
  );
  const commands = checks.jobs["factory-image"].steps.flatMap((step: { run?: string }) =>
    step.run ? [step.run] : [],
  );
  expect(commands[0]).toContain("docker build --file deploy/factory/Dockerfile");
  expect(commands[0]).not.toContain("--push");
  expect(commands[1]).toContain("image-smoke.ts");
});

test("native tools and Actor publication gate on packages, not retired Compose component proofs", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const build = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  );
  const proof = 'bash scripts/runtime/substrate-image-proof.sh "$image_id"';
  const packageBranches = build.run.slice(
    build.run.indexOf('if [[ "$role" == runtime-host ]]; then'),
  );
  for (const role of ["runtime-host", "substrate-runtime"]) {
    const branch = packageBranches
      .split(`[[ "$role" == ${role} ]]; then\n`)[1]
      ?.split(/\n\s*(?:elif|else|fi)\b/)[0];
    expect(branch?.trim()).toBe(proof);
  }
  expect(build.run.indexOf(proof)).toBeLessThan(build.run.indexOf("--push --metadata-file"));
  expect(JSON.stringify(workflow)).not.toMatch(
    /compose-inputs-proof|project-compose-prebuild-proof|NODE_PROOF_IMAGE|registry_proof_image|proof-tools|TestPrebuildComposeNative/,
  );
  expect(
    workflow.jobs.roles.steps.some((step: { uses?: string }) =>
      step.uses?.startsWith("actions/setup-go@"),
    ),
  ).toBe(false);
  for (const file of ["compose-inputs-proof.sh", "project-compose-prebuild-proof.sh"])
    expect(await Bun.file(new URL(`../runtime/${file}`, import.meta.url)).exists()).toBe(false);
  const packages = await readFile(
    new URL("../runtime/substrate-image-proof.sh", import.meta.url),
    "utf8",
  );
  expect(packages).toContain('"nativeActorLifecycle":false');
  expect(packages).not.toMatch(/go test|-test\.run|FACTORY_COMPOSE_|--privileged|--volume|--mount/);
});
