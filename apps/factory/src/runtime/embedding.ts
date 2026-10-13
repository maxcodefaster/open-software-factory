export function scopeRuntimeEmbedding(response: Response, factoryOrigin: string) {
  const origin = new URL(factoryOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== factoryOrigin) {
    throw new Error("Factory embedding requires its configured HTTP origin");
  }
  const headers = new Headers(response.headers);
  const ancestors = `frame-ancestors 'self' ${factoryOrigin}`;
  const policy = headers.get("content-security-policy");
  const directive = /(^|[;,])\s*frame-ancestors(?:\s+[^;,]*)?/gi;
  headers.set(
    "content-security-policy",
    policy
      ? directive.test(policy)
        ? policy.replace(directive, `$1 ${ancestors}`)
        : `${policy}; ${ancestors}`
      : ancestors,
  );
  // Factory is the authorized embedding shell. Keep App script/style policies, but
  // replace conflicting ancestor restrictions with this exact configured origin.
  headers.delete("x-frame-options");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
