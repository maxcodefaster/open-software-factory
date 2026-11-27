import { isDeepStrictEqual } from "node:util";
import { sql as query, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { type SubstrateProvisionResources, substrateProvision } from "#db/schema";
import {
  nativeMetadata,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { substrateTemplateSHA256 } from "./substrate";

export const boundNativeProvisioningResource = z.object({ metadata: nativeMetadata }).passthrough();
type Resource = z.infer<typeof boundNativeProvisioningResource>;
export const boundNativeProvisioningKinds = ["atespace", "policy", "template"] as const;
type Kind = (typeof boundNativeProvisioningKinds)[number];
type ProvisionSQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;
export type BoundNativeProvisioningFacts = {
  atespace: Resource | null;
  policy: Resource | null;
  template: Resource | null;
  atespaceAttemptedAt: Date | null;
  policyAttemptedAt: Date | null;
  templateAttemptedAt: Date | null;
  atespaceRejected: boolean;
  policyRejected: boolean;
  templateRejected: boolean;
};

export function readProvisionResources(
  resources: SubstrateProvisionResources | null | undefined,
): BoundNativeProvisioningFacts {
  const entry = (kind: Kind) => resources?.[kind];
  const timestamp = (kind: Kind) => {
    const value = entry(kind)?.attemptedAt;
    return typeof value === "string" ? new Date(value) : null;
  };
  const resourceValue = (kind: Kind) => {
    const value = entry(kind)?.value;
    return value ? (value as Resource) : null;
  };
  return {
    atespace: resourceValue("atespace"),
    policy: resourceValue("policy"),
    template: resourceValue("template"),
    atespaceAttemptedAt: timestamp("atespace"),
    policyAttemptedAt: timestamp("policy"),
    templateAttemptedAt: timestamp("template"),
    atespaceRejected: entry("atespace")?.rejected === true,
    policyRejected: entry("policy")?.rejected === true,
    templateRejected: entry("template")?.rejected === true,
  };
}

function patchProvisionResourceIn(
  sql: ProvisionSQL,
  where: SQL | undefined,
  kind: Kind,
  patch: SQL,
) {
  return drizzleTransaction(sql)
    .update(substrateProvision)
    .set({
      resources: query`jsonb_set(${substrateProvision.resources}, ARRAY[${kind}::text], COALESCE(${substrateProvision.resources} -> ${kind}::text, '{}'::jsonb) || ${patch}, true)`,
    })
    .where(where);
}

export function dispatchProvisionResourceIn(sql: ProvisionSQL, where: SQL | undefined, kind: Kind) {
  return patchProvisionResourceIn(
    sql,
    where,
    kind,
    query`jsonb_build_object('attemptedAt', to_jsonb(now()))`,
  );
}

export function rejectProvisionResourceIn(sql: ProvisionSQL, where: SQL | undefined, kind: Kind) {
  return patchProvisionResourceIn(sql, where, kind, query`'{"rejected":true}'::jsonb`);
}

export function rememberProvisionResourceIn(
  sql: ProvisionSQL,
  where: SQL | undefined,
  kind: Kind,
  value: Resource,
) {
  return patchProvisionResourceIn(
    sql,
    where,
    kind,
    query`jsonb_build_object('value', ${JSON.stringify(value)}::text::jsonb)`,
  );
}

// Requests and identity checks for these three concrete native resources only.
// The caller retains authorization, locks, durable intent and dispatch/outcome writes.
export function boundNativeProvisioningChecks(
  label: "Workspace" | "Verification" | "isolated",
  atespace: string,
  editorPrincipal: string,
  template: ReturnType<typeof import("./substrate-template").renderSubstrateTemplate>,
  templateSHA256: string,
) {
  const bindings = [{ role: "editor", members: [editorPrincipal] }];
  const declarations = {
    atespace: {
      name: atespace,
      getMethod: "GetAtespace",
      createMethod: "CreateAtespace",
      getRequest: { atespace: { name: atespace } },
      createRequest: { atespace: { metadata: { name: atespace } } },
    },
    policy: {
      name: "default",
      getMethod: "GetAtespaceAccessPolicy",
      createMethod: "CreateAtespaceAccessPolicy",
      getRequest: { atespace: { name: atespace }, name: "default" },
      createRequest: {
        atespace: { name: atespace },
        accessPolicy: { metadata: { name: "default" }, bindings },
      },
    },
    template: {
      name: "runtime",
      getMethod: "GetActorTemplate",
      createMethod: "CreateActorTemplate",
      getRequest: { actorTemplate: { atespace, name: "runtime" } },
      createRequest: { actorTemplate: template },
    },
  };
  return (kind: (typeof boundNativeProvisioningKinds)[number]) => ({
    ...declarations[kind],
    requireOriginal(value: Resource, original: Resource | null, attempted: Date | null) {
      if (
        !attempted ||
        value.metadata.name !== declarations[kind].name ||
        value.metadata.atespace !== (kind === "template" ? atespace : undefined) ||
        Date.parse(value.metadata.createTime) < attempted.getTime() ||
        (original &&
          (original.metadata.uid !== value.metadata.uid ||
            original.metadata.version !== value.metadata.version))
      )
        throw new Error(`Native ${label} provisioning resource differs from its original identity`);
      if (kind === "template" && substrateTemplateSHA256(value) !== templateSHA256)
        throw new Error(`Native ${label} template differs from its frozen intent`);
      if (kind === "policy" && !isDeepStrictEqual(value["bindings"], bindings))
        throw new Error(`Native ${label} editor grant differs from intent`);
    },
  });
}

// The purpose owner holds its existing lock and supplies its durable writes and
// live authority. Only the mechanical sequence for these three resources is shared.
export async function provisionBoundNativeResources<T extends BoundNativeProvisioningFacts>(input: {
  label: string;
  checks: ReturnType<typeof boundNativeProvisioningChecks>;
  editor: SubstrateCall;
  owner: SubstrateCall;
  read(): Promise<T>;
  authorize(): Promise<unknown>;
  dispatch(kind: Kind): Promise<unknown>;
  reject(kind: Kind): Promise<unknown>;
  remember(kind: Kind, value: Resource): Promise<unknown>;
}): Promise<T> {
  let row = await input.read();
  for (const kind of boundNativeProvisioningKinds) {
    if (row[`${kind}Rejected`])
      throw new Error(
        `Native ${input.label} Create was rejected; foreign resources are never adopted`,
      );
    const call = kind === "template" ? input.editor : input.owner;
    const check = input.checks(kind);
    if (!row[`${kind}AttemptedAt`]) {
      if (await absentBoundNativeResource(call, check.getMethod, check.getRequest))
        throw new Error(`Preexisting native ${input.label} resource was not adopted`);
      await input.authorize();
      await input.dispatch(kind);
      row = await input.read();
      try {
        const created = boundNativeProvisioningResource.parse(
          await call(check.createMethod, check.createRequest),
        );
        check.requireOriginal(created, row[kind], row[`${kind}AttemptedAt`]);
        await input.remember(kind, kind === "template" ? { metadata: created.metadata } : created);
      } catch (error) {
        if (boundNativeCreateRejected(error)) await input.reject(kind);
        throw error;
      }
      row = await input.read();
    }
    // Once the grant is confirmed, even Atespace observations use the Editor.
    const observer = kind === "template" || row.policy ? input.editor : input.owner;
    const actual = boundNativeProvisioningResource.parse(
      await observer(check.getMethod, check.getRequest),
    );
    check.requireOriginal(actual, row[kind], row[`${kind}AttemptedAt`]);
    if (!row[kind]) {
      await input.remember(kind, kind === "template" ? { metadata: actual.metadata } : actual);
      row = await input.read();
    }
  }
  return row;
}

export async function absentBoundNativeResource(
  call: SubstrateCall,
  method: string,
  request: unknown,
) {
  try {
    return await call(method, request);
  } catch (error) {
    if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
    throw error;
  }
}

export function boundNativeCreateRejected(error: unknown) {
  return (
    error instanceof SubstrateRPCError &&
    ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"].includes(error.code)
  );
}
