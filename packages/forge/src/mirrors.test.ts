import { expect, test } from "bun:test";
import { createForgejoClient } from "./forge";
import { ForgeMirrorWriteError } from "./mirrors";

const repo = { owner: "owned", name: "source" };
const native = {
  remote_name: "remote_mirror_owned",
  remote_address: "https://user:do-not-expose@github.com/team/copy.git?token=hidden",
  sync_on_commit: true,
  interval: "1h0m0s",
  branch_filter: "",
  last_update: "2026-10-27T09:00:00Z",
  last_error: "fatal: private-token-in-native-error",
};

test("native push mirrors use pinned routes, all refs, hourly and push-triggered sync without leaking credentials", async () => {
  const calls: { url: string; method: string }[] = [];
  const client = createForgejoClient({
    apiURL: "https://forge.invalid/api/v1/",
    token: "native-service-token",
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method });
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer native-service-token");
      if (method === "POST" && !String(url).endsWith("-sync")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          remote_address: "https://github.com/team/copy.git",
          remote_username: "user",
          remote_password: "target-token",
          sync_on_commit: true,
          interval: "1h",
          branch_filter: "",
          use_ssh: false,
        });
        return Response.json(native);
      }
      if (method === "GET") return Response.json([native]);
      return new Response(null, { status: 204 });
    },
  }).pushMirrors;
  const created = await client.create(repo, {
    targetURL: "https://github.com/team/copy.git",
    username: "user",
    token: "target-token",
  });
  expect(created.targetURL).toBe("https://github.com/team/copy.git");
  expect(created.failed).toBe(true);
  expect(JSON.stringify(created)).not.toContain("do-not-expose");
  expect(JSON.stringify(created)).not.toContain("private-token");
  expect(JSON.stringify(await client.list(repo))).not.toContain("hidden");
  await client.sync(repo);
  await client.remove(repo, native.remote_name);
  expect(calls.map((item) => item.method)).toEqual(["POST", "GET", "POST", "DELETE"]);
  expect(calls[2]?.url).toEndWith("/repos/owned/source/push_mirrors-sync");
  expect(calls[3]?.url).toEndWith("/repos/owned/source/push_mirrors/remote_mirror_owned");
});

test("mirror transport paginates, treats zero time as unconfirmed and does not retry rejected or ambiguous creates", async () => {
  let requests = 0;
  const client = createForgejoClient({
    apiURL: "https://forge.invalid/api/v1/",
    token: "service",
    fetch: async (url, init) => {
      requests++;
      if (init?.method === "POST") return new Response("sensitive native body", { status: 500 });
      const page = new URL(String(url)).searchParams.get("page");
      return Response.json(
        page === "1"
          ? Array.from({ length: 50 }, (_, index) => ({
              ...native,
              remote_name: `mirror_${index}`,
              last_update: "0001-01-01T00:00:00Z",
            }))
          : [],
      );
    },
  }).pushMirrors;
  const mirrors = await client.list(repo);
  expect(mirrors).toHaveLength(50);
  expect(mirrors[0]?.lastAttempt).toBeNull();
  await expect(
    client.create(repo, { targetURL: "https://github.com/a/b", username: "user", token: "secret" }),
  ).rejects.toBeInstanceOf(ForgeMirrorWriteError);
  expect(requests).toBe(3);
});
