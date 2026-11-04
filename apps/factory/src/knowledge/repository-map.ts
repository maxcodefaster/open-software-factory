export type InventoryFile = { path: string; size: number };

type Directory = { files: number; bytes: number; children: Map<string, Directory> };

const manifestPattern =
  /(^|\/)(package\.json|go\.mod|pyproject\.toml|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|gemfile|dockerfile|docker-compose\.ya?ml|astro\.config\.[mc]?[jt]s|vite\.config\.[mc]?[jt]s|next\.config\.[mc]?[jt]s|system\.json)$/i;
const documentPattern = /\.mdx?$/i;

function build(files: readonly InventoryFile[]) {
  const root: Directory = { files: 0, bytes: 0, children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    node.files += 1;
    node.bytes += file.size;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) {
        child = { files: 0, bytes: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.files += 1;
      child.bytes += file.size;
      node = child;
    }
  }
  return root;
}

function walk(node: Directory, depth: number, prefix: string, lines: string[], budget: number) {
  const children = [...node.children.entries()].sort(
    (a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]),
  );
  for (const [name, child] of children) {
    if (lines.length >= budget) return;
    lines.push(`${prefix}${name}/ (${child.files} files)`);
    if (depth > 1) walk(child, depth - 1, `${prefix}  `, lines, budget);
  }
}

/**
 * A compact, deterministic orientation for Wiki agents. It replaces the complete file list:
 * agents discover paths with the directory and search tools and read only what they need.
 */
export function repositoryMap(files: readonly InventoryFile[]) {
  const root = build(files);
  const tree: string[] = [];
  walk(root, 3, "", tree, 120);
  const manifests = files
    .filter((file) => manifestPattern.test(file.path))
    .sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
    )
    .slice(0, 40)
    .map((file) => file.path);
  const documents = files
    .filter((file) => documentPattern.test(file.path))
    .sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
    )
    .slice(0, 30)
    .map((file) => file.path);
  return {
    files: root.files,
    note: "This is a map, not the file list. Use listDirectory and findFiles to discover paths, then readSource for the few files you need.",
    directories: tree,
    manifests,
    documents,
  };
}

function normalize(path: string) {
  return path.replace(/^\/+|\/+$/g, "");
}

/** One level of a directory: child directories with counts, then files, paged. */
export function listDirectory(
  files: readonly InventoryFile[],
  path: string,
  offset = 0,
  limit = 60,
) {
  const base = normalize(path);
  const prefix = base ? `${base}/` : "";
  const directories = new Map<string, number>();
  const direct: InventoryFile[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) direct.push(file);
    else directories.set(rest.slice(0, slash), (directories.get(rest.slice(0, slash)) ?? 0) + 1);
  }
  const entries = [
    ...[...directories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${prefix}${name}/ (${count} files)`),
    ...direct
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path} (${file.size} bytes)`),
  ];
  return {
    path: base || ".",
    total: entries.length,
    entries: entries.slice(offset, offset + limit),
    nextOffset: offset + limit < entries.length ? offset + limit : null,
  };
}
