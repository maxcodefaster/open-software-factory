// Autonomous Delivery is deliberately narrower than ordinary human-approved
// work. Unlisted paths require a human decision, not a broader model verdict.
export function applicationFixPath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part.startsWith(".")) ||
    /(?:^|\/)(?:node_modules|vendor|dist|build|deploy|infra|infrastructure|terraform|helm|k8s|kubernetes|migrations|scripts|policies|policy|secrets|credentials)(?:\/|$)/i.test(
      path,
    ) ||
    /(?:^|\/)(?:AGENTS|SKILL|CONTEXT|README|Dockerfile|Containerfile)(?:\.|$)/i.test(path) ||
    /(?:^|\/)(?:[^/]*\.)?(?:config|setup)\.[^/]+$/i.test(path) ||
    /(?:secret|credential|private[-_]?key|auth[-_]?policy)/i.test(path)
  )
    return false;
  return /\.(?:tsx?|jsx?|mjs|cjs|go|py|rs|java|kt|cs|html|css|scss|svelte|vue|rb|php|exs?)$/i.test(
    path,
  );
}

export const applicationFixNonGoals = [
  "Do not change infrastructure, CI, dependencies, migrations, secrets, credentials, access policy or agent instructions.",
  "Do not weaken, skip or remove checks or regression coverage.",
  "Do not deploy to production or change the Project's System Contract.",
] as const;
