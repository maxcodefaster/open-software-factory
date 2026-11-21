import { describe, expect, test } from "bun:test";
import { createForgejoClient, ForgeAmbiguousWriteError, ForgeConflictError } from "./forge";

const repository = { owner: "factory", name: "fixture" };
const sha = "a".repeat(40);
const response = (value: unknown, status = 200) => Response.json(value, { status });
const branch = (name: string, headSha = sha) => ({ name, commit: { id: headSha } });

describe("complete repository file discovery", () => {
  const file = (path: string) => ({ path, type: "blob", sha, size: 12 });
  test("reads every page, including a short first page with a reported total", async () => {
    const requested: number[] = [];
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        requested.push(page);
        return response({
          tree: page === 1 ? [file("README.md")] : [file("docs/nested/guide.md")],
          total_count: 2,
          truncated: false,
        });
      },
    });
    expect((await client.listFiles(repository, sha)).map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/nested/guide.md",
    ]);
    expect(requested).toEqual([1, 2]);
  });
  test("recovers a truncated recursive tree through complete subtree traversal", async () => {
    const subtree = "b".repeat(40);
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("recursive") === "true")
          return response({ tree: [file("README.md")], truncated: true });
        if (url.pathname.endsWith(subtree))
          return response({ tree: [file("guide.md")], truncated: false });
        return response({
          tree: [file("README.md"), { path: "docs", type: "tree", sha: subtree }],
          truncated: false,
        });
      },
    });
    expect((await client.listFiles(repository, sha)).map((entry) => entry.path)).toEqual([
      "README.md",
      "docs/guide.md",
    ]);
  });
  test("rejects repeated pages rather than silently returning an incomplete inventory", async () => {
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response({ tree: [file("README.md")], total_count: 2, truncated: false }),
    });
    await expect(client.listFiles(repository, sha)).rejects.toThrow("incomplete");
  });
});

test("finds synchronized pull-request runs without trusting Forgejo's event filter", async () => {
  const client = createForgejoClient({
    apiURL: "http://forge/api/v1/",
    token: "secret",
    fetch: async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("head_sha")).toBe(sha);
      expect(url.searchParams.get("limit")).toBe("20");
      const run = (id: number, event: string, commitSha = sha) => ({
        id,
        html_url: `http://forge/factory/fixture/actions/runs/${id}`,
        commit_sha: commitSha,
        workflow_id: "factory-verification.yml",
        event,
        status: "waiting",
      });
      return response({
        workflow_runs: url.searchParams.has("event")
          ? []
          : [run(2, "pull_request"), run(3, "push"), run(4, "pull_request", "b".repeat(40))],
      });
    },
  });
  expect(await client.listActionRuns(repository, sha)).toEqual([
    {
      id: 2,
      url: "http://forge/factory/fixture/actions/runs/2",
      commitSha: sha,
      workflowID: "factory-verification.yml",
      event: "pull_request",
      status: "waiting",
    },
  ]);
});

describe("Forgejo branch creation", () => {
  test("returns an existing exact branch and rejects a conflicting head", async () => {
    const exact = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response(branch("factory/change-a")),
    });
    expect(await exact.ensureBranch(repository, "factory/change-a", sha)).toEqual({
      name: "factory/change-a",
      headSha: sha,
    });
    const conflict = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => response(branch("factory/change-a", "b".repeat(40))),
    });
    await expect(conflict.ensureBranch(repository, "factory/change-a", sha)).rejects.toBeInstanceOf(
      ForgeConflictError,
    );
  });

  test("recovers a conflict response by observing the exact branch", async () => {
    let call = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async (_input, init) => {
        call += 1;
        if (call === 1) return new Response(null, { status: 404 });
        if (init?.method === "POST") return new Response(null, { status: 409 });
        return response(branch("factory/change-a"));
      },
    });
    expect(await client.ensureBranch(repository, "factory/change-a", sha)).toEqual({
      name: "factory/change-a",
      headSha: sha,
    });
  });

  test("keeps an unresolved timeout ambiguous", async () => {
    let call = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "secret",
      fetch: async () => {
        call += 1;
        if (call === 2) throw new DOMException("timeout", "TimeoutError");
        return new Response(null, { status: 404 });
      },
    });
    await expect(client.ensureBranch(repository, "factory/change-a", sha)).rejects.toBeInstanceOf(
      ForgeAmbiguousWriteError,
    );
  });
});

describe("Forgejo transport rejection", () => {
  test.each(["exact", "absent", "unavailable"])(
    "checks the exact branch after an effect with a lost reply and %s readback",
    async (readback) => {
      let created = false;
      const calls: string[] = [];
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-fixture",
        fetch: async (input, init) => {
          const url = new URL(String(input));
          calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
          if (init?.method === "POST") {
            expect(JSON.parse(String(init.body))).toEqual({
              new_branch_name: "factory/change-a",
              old_ref_name: sha,
            });
            created = true;
            throw new TypeError("fetch failed after branch creation");
          }
          if (!created || readback === "absent") return response({}, 404);
          if (readback === "unavailable") return response({}, 503);
          return response(branch("factory/change-a"));
        },
      });
      const result = client.ensureBranch(repository, "factory/change-a", sha);
      if (readback === "exact")
        expect(await result).toEqual({ name: "factory/change-a", headSha: sha });
      else await expect(result).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
      expect(created).toBe(true);
      expect(calls).toEqual([
        "GET /api/v1/repos/factory/fixture/branches/factory%2Fchange-a",
        "POST /api/v1/repos/factory/fixture/branches",
        "GET /api/v1/repos/factory/fixture/branches/factory%2Fchange-a",
      ]);
    },
  );

  test("does not classify hook path validation as a transport rejection", async () => {
    let calls = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async () => {
        calls += 1;
        return response({});
      },
    });
    await expect(
      client.createPushHook({ ...repository, owner: ".." }, "https://hook.invalid", "test", "main"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  });

  test("does not classify hook response decoding as a transport rejection", async () => {
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async () => {
        const result = response({ id: 1, active: true, events: ["push"] });
        await result.json();
        return result;
      },
    });
    await expect(
      client.createPushHook(repository, "https://hook.invalid", "test", "main"),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("does not classify setup serialization errors as transport rejection", async () => {
    let calls = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async () => {
        calls += 1;
        return response({});
      },
    });
    await expect(
      client.createSetupFiles({
        repository,
        branch: "main",
        setupID: "owned-setup",
        files: [{ path: "README.md", content: {} as string }],
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  });

  test.each(["repository", "starter", "hook"])(
    "retains the uncertain %s creation for its caller after an effect with a lost reply",
    async (operation) => {
      const writes: unknown[] = [];
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-user",
        fetch: async (_input, init) => {
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-user");
          writes.push(JSON.parse(String(init?.body)));
          throw new TypeError("fetch failed after creation");
        },
      });
      const result =
        operation === "repository"
          ? client.createSetupRepository({
              repository,
              setupID: "owned-setup",
              sourceURL: "https://source.invalid/owned/repo.git",
              importToken: "owned-import",
            })
          : operation === "starter"
            ? client.createSetupFiles({
                repository,
                branch: "main",
                setupID: "owned-setup",
                files: [{ path: "README.md", content: "owned starter" }],
              })
            : client.createPushHook(repository, "https://hook.invalid", "owned-hook", "main");
      await expect(result).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
      expect(writes).toHaveLength(1);
      if (operation === "repository")
        expect(writes[0]).toMatchObject({ auth_token: "owned-import" });
    },
  );

  for (const rejection of ["fetch", "timeout"]) {
    test(`setup readback failure preserves uncertainty after ${rejection}`, async () => {
      let applied = false;
      let writes = 0;
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-user",
        fetch: async (_input, init) => {
          if (init?.method === "POST") {
            writes += 1;
            applied = true;
            throw rejection === "fetch"
              ? new TypeError("fetch failed after setup commit")
              : new DOMException("reply timed out", "TimeoutError");
          }
          return applied ? response({}, 503) : response(branch("factory/setup-a"));
        },
      });
      await expect(
        client.applySetupFiles({
          repository,
          branch: "factory/setup-a",
          baseCommit: sha,
          files: [{ path: ".factory/system.json", content: "{}" }],
          proposalID: "owned-proposal",
        }),
      ).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
      expect(writes).toBe(1);
    });

    test(`runner readback failure preserves uncertainty after ${rejection}`, async () => {
      let writes = 0;
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-user",
        fetch: async (_input, init) => {
          if (init?.method === "POST") {
            writes += 1;
            throw rejection === "fetch"
              ? new TypeError("fetch failed after runner registration")
              : new DOMException("reply timed out", "TimeoutError");
          }
          expect(init?.method ?? "GET").toBe("GET");
          return response({}, 503);
        },
      });
      await expect(
        client.registerEphemeralRunner(repository, "owned-runner"),
      ).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
      expect(writes).toBe(1);
    });

    test.each(["exact", "absent", "unavailable"])(
      `${rejection} rejection checks the pull request with %s readback`,
      async (readback) => {
        let created = false;
        let writes = 0;
        let reads = 0;
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-user",
          fetch: async (_input, init) => {
            if (init?.method === "POST") {
              writes += 1;
              created = true;
              throw rejection === "fetch"
                ? new TypeError("fetch failed after pull request creation")
                : new DOMException("reply timed out", "TimeoutError");
            }
            reads += 1;
            if (!created || readback === "absent") return response({}, 404);
            if (readback === "unavailable") return response({}, 503);
            return response({
              number: 1,
              html_url: "http://forge/factory/fixture/pulls/1",
              state: "open",
              merged: false,
              base: { ref: "main", sha },
              head: { ref: "factory/change-a", sha },
            });
          },
        });
        const result = client.ensurePullRequest({
          repository,
          baseBranch: "main",
          headBranch: "factory/change-a",
          expectedHeadSha: sha,
          title: "Owned change",
          body: "Owned proposal",
        });
        if (readback === "exact")
          expect(await result).toMatchObject({
            baseBranch: "main",
            headBranch: "factory/change-a",
            headSha: sha,
          });
        else await expect(result).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
        expect(writes).toBe(1);
        expect(reads).toBe(2);
      },
    );

    test.each(["exact", "unchanged", "unavailable"])(
      `${rejection} rejection checks the Document with %s readback`,
      async (readback) => {
        let applied = false;
        let writes = 0;
        const commit = "b".repeat(40);
        const blob = "c".repeat(40);
        const content = "owned revised Document";
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-user",
          fetch: async (input, init) => {
            if (init?.method === "PUT") {
              writes += 1;
              applied = true;
              throw rejection === "fetch"
                ? new TypeError("fetch failed after Document update")
                : new DOMException("reply timed out", "TimeoutError");
            }
            if (applied && readback === "unavailable") return response({}, 503);
            if (new URL(String(input)).pathname.includes("/branches/"))
              return response(branch("main", applied && readback === "exact" ? commit : sha));
            return response({
              content: Buffer.from(readback === "exact" ? content : "previous").toString("base64"),
              encoding: "base64",
              sha: blob,
            });
          },
        });
        const result = client.updateFile({
          repository,
          branch: "main",
          expectedBranchSha: sha,
          expectedBlobSha: sha,
          path: "README.md",
          content,
          message: "Revise owned Document",
        });
        if (readback === "exact")
          expect(await result).toEqual({ commitSha: commit, blobSha: blob });
        else await expect(result).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
        expect(writes).toBe(1);
      },
    );

    test.each(["exact", "unchanged", "unavailable"])(
      `${rejection} rejection checks the merged commit with %s readback`,
      async (readback) => {
        let merged = false;
        let writes = 0;
        let reads = 0;
        const commit = "b".repeat(40);
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-user",
          fetch: async (_input, init) => {
            if (init?.method === "POST") {
              writes += 1;
              merged = true;
              throw rejection === "fetch"
                ? new TypeError("fetch failed after merge")
                : new DOMException("reply timed out", "TimeoutError");
            }
            reads += 1;
            if (merged && readback === "unavailable") return response({}, 503);
            return response(branch("main", merged && readback === "exact" ? commit : sha));
          },
        });
        const result = client.mergeFastForward(repository, 1, commit, "main");
        if (readback === "exact") expect(await result).toEqual({ name: "main", headSha: commit });
        else await expect(result).rejects.toBeInstanceOf(ForgeAmbiguousWriteError);
        expect(writes).toBe(1);
        expect(reads).toBe(2);
      },
    );
  }

  test("recovers a lost runner token by deleting only the exact named registration before retry", async () => {
    const uuid = "00000000-0000-4000-8000-000000000001";
    let registrations = 0;
    const deleted: string[] = [];
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-user",
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          if (++registrations === 1) throw new TypeError("fetch failed after runner registration");
          return response({ id: 3, uuid, token: "owned-runner-token-for-test" });
        }
        if (init?.method === "DELETE") {
          deleted.push(new URL(String(input)).pathname);
          return new Response(null, { status: 204 });
        }
        return response(
          [
            { id: 1, name: "unrelated-runner" },
            { id: 2, name: "owned-runner" },
          ].map((runner) => ({ ...runner, uuid, ephemeral: true, status: "idle" })),
        );
      },
    });
    expect(await client.registerEphemeralRunner(repository, "owned-runner")).toEqual({
      id: 3,
      uuid,
      token: "owned-runner-token-for-test",
    });
    expect(registrations).toBe(2);
    expect(deleted).toEqual(["/api/v1/repos/factory/fixture/actions/runners/2"]);
  });
});

describe("default branch protection confirmation", () => {
  const workflow = ".forgejo/workflows/factory-verification.yml";
  for (const path of ["existing", "created", "recovered"]) {
    test.each(["wrong-branch", "writable", "omitted-workflow", "unprotected-workflow"])(
      `${path} protection rejects %s`,
      async (boundary) => {
        let reads = 0;
        let writes = 0;
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-fixture",
          fetch: async (_input, init) => {
            if (init?.method === "POST") {
              writes += 1;
              if (path === "recovered") throw new TypeError("fetch failed after protection");
            } else if (++reads === 1 && path !== "existing") return response({}, 404);
            return response({
              rule_name: boundary === "wrong-branch" ? "other" : "main",
              enable_push: boundary === "writable",
              ...(boundary === "omitted-workflow"
                ? {}
                : { protected_file_patterns: boundary === "unprotected-workflow" ? "" : workflow }),
            });
          },
        });
        const result = client.ensureDefaultBranchProtection(repository, "main");
        await expect(result).rejects.toBeInstanceOf(
          path === "recovered" ? ForgeAmbiguousWriteError : ForgeConflictError,
        );
        expect(writes).toBe(path === "existing" ? 0 : 1);
      },
    );

    test.each(["initial-import", "ready"])(
      `${path} healthy protection preserves %s setup authority`,
      async (stage) => {
        const protectWorkflow = stage === "ready";
        let reads = 0;
        let writes = 0;
        const value = {
          rule_name: "main",
          enable_push: false,
          protected_file_patterns: protectWorkflow ? `secrets/**;${workflow}` : "",
        };
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-user",
          fetch: async (_input, init) => {
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-user");
            if (init?.method === "POST") {
              writes += 1;
              expect(JSON.parse(String(init.body)).protected_file_patterns).toBe(
                protectWorkflow ? workflow : "",
              );
              if (path === "recovered") throw new TypeError("fetch failed after protection");
            } else if (++reads === 1 && path !== "existing") return response({}, 404);
            return response(value);
          },
        });
        expect(
          await client.ensureDefaultBranchProtection(repository, "main", protectWorkflow),
        ).toEqual(value);
        expect(writes).toBe(path === "existing" ? 0 : 1);
      },
    );

    test.each(["wrong-branch", "writable"])(
      `${path} imported setup exception still rejects %s`,
      async (boundary) => {
        let reads = 0;
        const client = createForgejoClient({
          apiURL: "http://forge/api/v1/",
          token: "owned-user",
          fetch: async (_input, init) => {
            if (init?.method === "POST") {
              if (path === "recovered") throw new TypeError("fetch failed after protection");
            } else if (++reads === 1 && path !== "existing") return response({}, 404);
            return response({
              rule_name: boundary === "wrong-branch" ? "other" : "main",
              enable_push: boundary === "writable",
            });
          },
        });
        await expect(
          client.ensureDefaultBranchProtection(repository, "main", false),
        ).rejects.toBeInstanceOf(
          path === "recovered" ? ForgeAmbiguousWriteError : ForgeConflictError,
        );
      },
    );
  }

  test.each(["absent", "unavailable", "lost"])(
    "protection effect with a lost reply remains uncertain after %s readback",
    async (readback) => {
      let written = false;
      let reads = 0;
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-user",
        fetch: async (_input, init) => {
          if (init?.method === "POST") {
            written = true;
            throw new TypeError("fetch failed after protection");
          }
          reads += 1;
          if (!written || readback === "absent") return response({}, 404);
          if (readback === "lost") throw new TypeError("readback failed");
          return response({}, 503);
        },
      });
      await expect(client.ensureDefaultBranchProtection(repository, "main")).rejects.toBeInstanceOf(
        ForgeAmbiguousWriteError,
      );
      expect(written).toBe(true);
      expect(reads).toBe(2);
    },
  );
});

test("concurrent main protection creation observes the exact result after Forgejo's duplicate 403", async () => {
  let reads = 0;
  const client = createForgejoClient({
    apiURL: "http://forge/api/v1/",
    token: "owned-fixture",
    fetch: async (_input, init) => {
      if (init?.method === "POST") return response({ message: "protection already exists" }, 403);
      if (++reads === 1) return response({}, 404);
      return response({
        rule_name: "main",
        enable_push: false,
        protected_file_patterns: ".forgejo/workflows/factory-verification.yml",
      });
    },
  });
  expect(await client.ensureDefaultBranchProtection(repository, "main")).toMatchObject({
    rule_name: "main",
    enable_push: false,
  });
  expect(reads).toBe(2);
});

describe("confirmed initial workflow merge", () => {
  const workflow = ".forgejo/workflows/factory-verification.yml";
  test.each([false, true])(
    "only relaxes the missing workflow rule and restores protection after merge failure=%s",
    async (failMerge) => {
      let head = sha;
      let patterns = `${workflow};secrets/**`;
      const updates: string[] = [];
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-fixture",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/branches/main")) return response(branch("main", head));
          if (path.includes("/contents/")) return response({}, 404);
          if (path.endsWith("/branch_protections/main")) {
            if (init?.method === "PATCH") {
              patterns = JSON.parse(String(init.body)).protected_file_patterns;
              updates.push(patterns);
            }
            return response({
              rule_name: "main",
              enable_push: false,
              protected_file_patterns: patterns,
            });
          }
          if (path.endsWith("/pulls/1/merge")) {
            expect(patterns).toBe("secrets/**");
            if (failMerge) return response({}, 409);
            head = "b".repeat(40);
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected owned route ${path}`);
        },
      });
      const merge = client.mergeInitialSetupWorkflow(repository, 1, "b".repeat(40), "main", sha);
      if (failMerge) await expect(merge).rejects.toThrow("409");
      else expect((await merge)?.headSha).toBe("b".repeat(40));
      expect(updates).toEqual(["secrets/**", `secrets/**;${workflow}`]);
    },
  );
  test("a merge Forgejo still checks is asked again until it can merge", async () => {
    let head = sha;
    let asked = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/branches/main")) return response(branch("main", head));
        if (path.endsWith("/pulls/1/merge")) {
          asked += 1;
          if (asked < 3) return response("Please try again later", 405);
          head = "b".repeat(40);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected owned route ${path}`);
      },
    });
    expect((await client.mergeFastForward(repository, 1, "b".repeat(40), "main"))?.headSha).toBe(
      "b".repeat(40),
    );
    expect(asked).toBe(3);
  });

  test.each(["existing-workflow", "changed-main", "writable-main"])(
    "refuses to relax protection for %s",
    async (boundary) => {
      const client = createForgejoClient({
        apiURL: "http://forge/api/v1/",
        token: "owned-fixture",
        fetch: async (input, init) => {
          expect(init?.method ?? "GET").toBe("GET");
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/branches/main"))
            return response(branch("main", boundary === "changed-main" ? "c".repeat(40) : sha));
          if (path.includes("/contents/"))
            return boundary === "existing-workflow"
              ? response({ content: Buffer.from("existing").toString("base64"), sha })
              : response({}, 404);
          return response({
            rule_name: "main",
            enable_push: true,
            protected_file_patterns: workflow,
          });
        },
      });
      await expect(
        client.mergeInitialSetupWorkflow(repository, 1, "b".repeat(40), "main", sha),
      ).rejects.toThrow();
    },
  );
});

test.each(["absent", "writable", "wrong-branch", "unprotected-workflow"])(
  "a denied protection create does not claim success for %s observed state",
  async (boundary) => {
    let reads = 0;
    const client = createForgejoClient({
      apiURL: "http://forge/api/v1/",
      token: "owned-fixture",
      fetch: async (_input, init) => {
        if (init?.method === "POST") return response({}, 403);
        if (++reads === 1 || boundary === "absent") return response({}, 404);
        return response({
          rule_name: boundary === "wrong-branch" ? "other" : "main",
          enable_push: boundary === "writable",
          protected_file_patterns:
            boundary === "unprotected-workflow"
              ? ""
              : ".forgejo/workflows/factory-verification.yml",
        });
      },
    });
    await expect(client.ensureDefaultBranchProtection(repository, "main")).rejects.toThrow("403");
  },
);
