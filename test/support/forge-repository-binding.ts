import type { createDatabase } from "../../packages/db/src/client";

export const forgeBinding = {
  apiURL: "http://forge-control.native.test:3000/api/v1/",
  publicURL: "https://git.native.test",
  owner: "owned",
};

// Shared by the Forge adapter and its Source, mirror, Verification and review callers.
export function forgeRepositoryBindingMatrix(binding = forgeBinding) {
  const origins = [...new Set([new URL(binding.apiURL).origin, new URL(binding.publicURL).origin])];
  const accepted = origins.flatMap((origin) =>
    ["repo", "repo.git", "repo.with-dots_and-dashes.git", ".repo.git", "repo..name"].map(
      (name) => ({
        url: `${origin}/${binding.owner}/${name}`,
        repository: { owner: binding.owner, name: name.replace(/\.git$/, "") },
      }),
    ),
  );
  const malformed = [
    "",
    "not a URL",
    `/${binding.owner}/repo.git`,
    `//git.native.test/${binding.owner}/repo.git`,
    `file:///${binding.owner}/repo.git`,
    `ssh://git.native.test/${binding.owner}/repo.git`,
    `https://foreign.native.test/${binding.owner}/repo.git`,
    ...origins.flatMap((origin) => {
      const url = `${origin}/${binding.owner}/repo.git`;
      const authority = origin.split("://")[1];
      return [
        origin,
        `${origin}/repo.git`,
        `${origin}/foreign/repo.git`,
        `${origin}/${binding.owner.toUpperCase()}/repo.git`,
        `${origin}/nested/${binding.owner}/repo.git`,
        `${origin}//${binding.owner}/repo.git`,
        `${origin}/${binding.owner}//repo.git`,
        `${url}/`,
        `${url}/extra`,
        `${url}?ref=main`,
        `${url}?`,
        `${url}#source`,
        `${url}#`,
        `${origin}/${binding.owner}/repo%2fother.git`,
        `${origin}/${binding.owner}/repo%5cother.git`,
        `${origin}/%6fwned/repo.git`,
        `${origin}/${binding.owner}/repo%00.git`,
        `${origin}/${binding.owner}/repo%2egit`,
        `${origin}/${binding.owner}/repo git`,
        `${origin}/${binding.owner}/repo+name.git`,
        `${origin}/${binding.owner}/repo:ref.git`,
        `${origin}/${binding.owner}/repo.git/../repo.git`,
        `${origin}/foreign/../${binding.owner}/repo.git`,
        `${origin}/./${binding.owner}/repo.git`,
        `${origin}/%2e/${binding.owner}/repo.git`,
        `${origin}/%2e%2e/${binding.owner}/repo.git`,
        ...[".", "..", ".git", "..git", "...git"].map(
          (name) => `${origin}/${binding.owner}/${name}`,
        ),
        `${origin.replace("://", ":/")}/${binding.owner}/repo.git`,
        `${origin.replace("://", ":///")}/${binding.owner}/repo.git`,
        `${origin.replace("://", "://user:secret@")}/${binding.owner}/repo.git`,
        `${origin.replace("://", "://@")}/${binding.owner}/repo.git`,
        `${origin.replace("://", "://:secret@")}/${binding.owner}/repo.git`,
        `${origin.replace("://", "://%")}/${binding.owner}/repo.git`,
        `${origin}.foreign.invalid/${binding.owner}/repo.git`,
        `${origin.replace("http:", "ftp:").replace("https:", "ftp:")}/${binding.owner}/repo.git`,
        `${origin.includes("https:") ? "http" : "https"}://${authority}/${binding.owner}/repo.git`,
        `${origin.replace("://", ":\\\\")}/${binding.owner}/repo.git`,
        `${origin}\\${binding.owner}\\repo.git`,
        ` ${url}`,
        `${url} `,
        `${url}\n`,
        `${origin}/${binding.owner}/re\tpo.git`,
        `${origin}/${binding.owner}/re\npo.git`,
        `${origin}/${binding.owner}/re\rpo.git`,
        `${origin}/${binding.owner}/re${String.fromCharCode(127)}po.git`,
        `${origin.slice(0, 8)}\0${origin.slice(8)}/${binding.owner}/repo.git`,
      ];
    }),
  ];
  const wrongPort = new URL(binding.publicURL);
  wrongPort.port = wrongPort.port === "444" ? "445" : "444";
  malformed.push(`${wrongPort.origin}/${binding.owner}/repo.git`);
  return { accepted, malformed };
}

export function useForgeBindingEnvironment(binding = forgeBinding) {
  const values = {
    FACTORY_FORGEJO_API_URL: binding.apiURL,
    FACTORY_FORGEJO_PUBLIC_URL: binding.publicURL,
    FACTORY_FORGEJO_OWNER: binding.owner,
    FACTORY_FORGEJO_TOKEN: "owned-binding-test-token",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

// Replace only database I/O. Controllers still run their authority code and
// Drizzle's actual builder/result mapping; unexpected queries fail the test.
export function forgeBindingDatabase(
  raw: (text: string, parameters: unknown[]) => unknown[],
  typed: (text: string, parameters: unknown[]) => unknown[][] = (text) => {
    throw new Error(`Unexpected typed binding query: ${text}`);
  },
) {
  const statements: Array<{ text: string; parameters: unknown[] }> = [];
  const client = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push({ text, parameters });
      return Promise.resolve(raw(text, parameters));
    },
    {
      unsafe(text: string, parameters: unknown[]) {
        statements.push({ text, parameters });
        const rows = typed(text, parameters);
        return { values: async () => rows };
      },
      async begin<T>(work: (sql: unknown) => Promise<T>): Promise<T> {
        return work(client);
      },
      json: (value: unknown) => value,
    },
  );
  const database = {
    client,
    coordination() {
      throw new Error("Unexpected binding coordination connection");
    },
  } as unknown as ReturnType<typeof createDatabase>;
  return { database, statements };
}
