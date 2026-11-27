// Self-contained archive verifier and staging extractor (serialized via invocation()).
import type { FileWitness, Source, Witnesses } from "./restore-rehearsal-types";

// Runs through `docker exec -i ... node --input-type=module` using only the pinned Node image.
// The optional root is for synthetic local unit fixtures, never an operator-controlled destination.
export async function restoreFiles(config: {
  root: string;
  set: string;
  source: Source;
  diskBytes: number;
  witnessDigest?: string;
  verifyOnly?: boolean;
}) {
  const fs = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const { createHash, randomBytes } = await import("node:crypto");
  const { createGunzip } = await import("node:zlib");
  const path = await import("node:path");
  const at = (name: string) => `${config.root}${name}`;
  const w: Witnesses = JSON.parse(await fs.readFile(at("/input/witnesses.json"), "utf8"));
  const fail = (): never => {
    throw Error(
      "Archive, content witness or original state identity failed; raw diagnostics suppressed",
    );
  };
  const check = (ok: unknown) => {
    if (!ok) fail();
  };
  check(
    w.forgejo.files.some(
      (entry) => entry.path === "forgejo.sqlite3" && entry.link === undefined && entry.bytes > 0,
    ),
  );
  check(
    !config.witnessDigest ||
      createHash("sha256").update(JSON.stringify(w)).digest("hex") === config.witnessDigest,
  );
  const badChars = (v: string) => [...v].some((c) => c.charCodeAt(0) < 32 || c === "\\");
  const safe = (name: string) => {
    const v = name.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    if (!v || v === ".") return "";
    check(
      !path.isAbsolute(v) &&
        !badChars(v) &&
        v.split("/").every((p) => p && p !== "." && p !== ".."),
    );
    return v;
  };
  const checkSymlinkTarget = (link: string, base: string, root: string) => {
    check(!path.isAbsolute(link) && !badChars(link));
    const rel = path.relative(root, path.resolve(path.dirname(base), link));
    check(rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel));
  };
  async function parents(file: string, root: string) {
    const rel = path.relative(root, path.dirname(file));
    check(!rel.startsWith("..") && !path.isAbsolute(rel));
    let parent = root;
    for (const part of rel.split("/").filter(Boolean)) {
      parent = path.join(parent, part);
      await fs.mkdir(parent, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      const info = await fs.lstat(parent);
      check(info.isDirectory() && !info.isSymbolicLink());
    }
  }
  async function fileHash(file: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  }
  async function verifyObjectInput(entry: FileWitness) {
    const src = at(`/input/objects/${entry.path}`);
    const info = await fs.lstat(src);
    check(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.size === entry.bytes &&
        (await fileHash(src)) === entry.sha256,
    );
    return src;
  }
  async function copyOwned(
    src: string,
    dst: string,
    uid: number,
    gid: number,
    mode: number,
    expectedHash?: string,
  ) {
    await fs.copyFile(src, dst, 1);
    check(expectedHash === undefined || (await fileHash(dst)) === expectedHash);
    await fs.chown(dst, uid, gid);
    await fs.chmod(dst, mode);
  }
  type Destination = { root: string; relative: string } | null;
  // Strict streaming tar reader: sparse files, devices, FIFOs and unknown extensions refuse.
  async function archive(
    file: string,
    expected: FileWitness[],
    destination: (name: string) => Destination,
    snapshot = false,
  ) {
    const source = createReadStream(file);
    const unzip = source.pipe(createGunzip());
    source.on("error", (error) => unzip.destroy(error));
    const iterator = unzip[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    let offset = 0;
    async function consume(size: number, sink?: (bytes: Buffer) => Promise<void>) {
      while (size > 0) {
        if (offset === buffer.length) {
          const next = await iterator.next();
          check(!next.done);
          buffer = Buffer.from(next.value as Uint8Array);
          offset = 0;
        }
        const n = Math.min(size, buffer.length - offset);
        const chunk = buffer.subarray(offset, offset + n);
        if (sink) await sink(chunk);
        offset += n;
        size -= n;
      }
    }
    async function small(size: number) {
      check(size <= 1024 ** 2);
      const chunks: Buffer[] = [];
      await consume(size, async (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      return Buffer.concat(chunks);
    }
    const text = (b: Buffer, start: number, len: number) =>
      b
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/, "");
    const octal = (h: Buffer, start: number, len: number) => {
      const raw = h
        .subarray(start, start + len)
        .toString("ascii")
        .replace(/\0.*$/, "")
        .trim();
      check(/^[0-7]*$/.test(raw));
      const v = Number.parseInt(raw || "0", 8);
      check(Number.isSafeInteger(v) && v >= 0);
      return v;
    };
    const wanted = new Map(expected.map((entry) => [entry.path, entry]));
    const seen = new Set<string>();
    const symlinks = new Map<string, Map<string, string>>();
    const snapshotHashes = new Map<string, string>();
    const dirs: { file: string; mode: number; uid: number; gid: number }[] = [];
    let sums = "";
    let ext: Record<string, string> = {};
    const parsePax = (data: Buffer) => {
      for (let cursor = 0; cursor < data.length; ) {
        const space = data.indexOf(32, cursor);
        const length = Number(data.subarray(cursor, space).toString("ascii"));
        check(
          space >= cursor &&
            Number.isSafeInteger(length) &&
            length > space - cursor + 2 &&
            cursor + length <= data.length,
        );
        const rec = data.subarray(space + 1, cursor + length - 1).toString("utf8");
        const eq = rec.indexOf("=");
        const key = rec.slice(0, eq);
        check(
          eq >= 1 && ["path", "linkpath", "mtime", "atime", "ctime", "uid", "gid"].includes(key),
        );
        ext[key] = rec.slice(eq + 1);
        cursor += length;
      }
    };
    try {
      for (;;) {
        const header = await small(512);
        if (header.every((byte) => byte === 0)) {
          const second = await small(512);
          check(
            second.every((b) => b === 0) &&
              !Object.keys(ext).length &&
              buffer.subarray(offset).every((b) => b === 0),
          );
          for await (const chunk of { [Symbol.asyncIterator]: () => iterator })
            check(Buffer.from(chunk as Uint8Array).every((b) => b === 0));
          break;
        }
        let actual = 0;
        header.forEach((v, i) => {
          actual += i >= 148 && i < 156 ? 32 : v;
        });
        check(octal(header, 148, 8) === actual);
        let name = text(header, 0, 100);
        const prefix = text(header, 345, 155);
        if (text(header, 257, 6) === "ustar" && header[262] === 0 && prefix)
          name = `${prefix}/${name}`;
        const type = text(header, 156, 1) || "0";
        const size = octal(header, 124, 12);
        if (["x", "L", "K"].includes(type)) {
          const data = await small(size);
          if (type === "L")
            ext["path"] = data.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
          else if (type === "K")
            ext["linkpath"] = data.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
          else parsePax(data);
          await consume((512 - (size % 512)) % 512);
          continue;
        }
        name = safe(ext["path"] ?? name);
        const link = ext["linkpath"] ?? text(header, 157, 100);
        const uid = Number(ext["uid"] ?? octal(header, 108, 8));
        const gid = Number(ext["gid"] ?? octal(header, 116, 8));
        const mode = octal(header, 100, 8) & 0o777;
        ext = {};
        check(
          [uid, gid].every((v) => Number.isSafeInteger(v) && v >= 0) &&
            ["0", "2", "5"].includes(type) &&
            (type === "0" || size === 0),
        );
        const target = name || type === "5" ? destination(name) : null;
        if (type === "5") {
          if (target && !config.verifyOnly) {
            const file = path.join(target.root, target.relative);
            await parents(path.join(file, ".directory"), target.root);
            dirs.push({ file, mode, uid, gid });
          }
          continue;
        }
        const witness = wanted.get(name);
        if (snapshot)
          check(
            ["meta.json", "state.bin", "SHA256SUMS", "SHA256SUMS.sealed"].includes(name) &&
              !seen.has(name) &&
              type === "0" &&
              (name !== "SHA256SUMS" || size <= 1024 ** 2),
          );
        else
          check(
            witness &&
              !seen.has(name) &&
              witness.bytes === size &&
              (type === "2") === (witness.link !== undefined) &&
              (type !== "2" || witness.link === link),
          );
        seen.add(name);
        const hash = createHash("sha256");
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        if (type === "2") {
          const base = target
            ? path.join(target.root, target.relative)
            : path.join("/checked-archive", name);
          const root = target?.root ?? "/checked-archive";
          checkSymlinkTarget(link, base, root);
          const links = symlinks.get(root) ?? new Map<string, string>();
          links.set(path.relative(root, base), link);
          symlinks.set(root, links);
        }
        const output =
          target && !config.verifyOnly ? path.join(target.root, target.relative) : null;
        if (output && target) await parents(output, target.root);
        try {
          if (output && type === "0") handle = await fs.open(output, "wx", 0o600);
          await consume(size, async (chunk) => {
            hash.update(chunk);
            if (snapshot && name === "SHA256SUMS") sums += chunk.toString("utf8");
            if (handle) await handle.writeFile(chunk);
          });
          if (type === "2") hash.update(link);
          const actualHash = hash.digest("hex");
          if (snapshot) snapshotHashes.set(name, actualHash);
          else check(actualHash === witness?.sha256);
          if (output) {
            if (type === "2") {
              checkSymlinkTarget(link, output, target?.root ?? "");
              await fs.symlink(link, output);
              await fs.lchown(output, uid, gid);
            } else {
              await handle?.chown(uid, gid);
              await handle?.chmod(mode);
            }
          }
        } finally {
          await handle?.close();
        }
        await consume((512 - (size % 512)) % 512);
      }
      if (snapshot) {
        check(["meta.json", "state.bin", "SHA256SUMS"].every((v) => seen.has(v)));
        for (const name of ["meta.json", "state.bin"])
          check(
            sums
              .split("\n")
              .some(
                (l) =>
                  l === `${snapshotHashes.get(name)}  ${name}` ||
                  l === `${snapshotHashes.get(name)} *${name}`,
              ),
          );
      } else check(seen.size === wanted.size);
      // Resolve components in filesystem order so chained or forward symlinks cannot escape.
      for (const links of symlinks.values())
        for (const name of links.keys()) {
          let pending = name.split("/");
          const resolved: string[] = [];
          let hops = 0;
          while (pending.length) {
            const part = pending.shift();
            if (!part || part === ".") continue;
            if (part === "..") {
              check(resolved.length);
              resolved.pop();
              continue;
            }
            resolved.push(part);
            const target = links.get(resolved.join("/"));
            if (target !== undefined) {
              check(target && ++hops <= 40);
              resolved.pop();
              pending = [...target.split("/"), ...pending];
            }
          }
        }
      for (const entry of dirs.reverse()) {
        await fs.chown(entry.file, entry.uid, entry.gid);
        await fs.chmod(entry.file, entry.mode);
      }
    } finally {
      source.destroy();
      unzip.destroy();
    }
  }
  const roots = [
    "/control",
    "/state",
    "/forgejo",
    "/forgejo-config",
    "/bao-data",
    "/pg-data",
    "/objects-data",
    "/objects-input",
  ];
  for (const root of roots) {
    check(!(await fs.readdir(at(root))).length);
    const disk = await fs.statfs(at(root));
    check(Number(disk.bavail) * Number(disk.bsize) >= config.diskBytes);
  }
  for (const [name, expected] of Object.entries(w.parts))
    check((await fileHash(at(`/input/${config.set}/${name}`))) === expected);
  await archive(at(`/input/${config.set}/state.tar.gz`), w.state.files, (name) =>
    w.state.excludedProvisionerPaths.includes(name) ? null : { root: at("/state"), relative: name },
  );
  await archive(at(`/input/${config.set}/forgejo.tar.gz`), w.forgejo.files, (name) => {
    if (name === "forgejo.sqlite3") return { root: at("/forgejo"), relative: "data/forgejo.db" };
    if (name === "forgejo-db.sql" || name === "data" || name === "repos") return null;
    if (name === "app.ini") return { root: at("/forgejo-config"), relative: "app.ini" };
    if (name.startsWith("data/"))
      return /^data\/data\/forgejo\.db(?:$|[-.])/.test(name)
        ? null
        : { root: at("/forgejo"), relative: name.slice(5) };
    if (name.startsWith("repos/"))
      return { root: at("/forgejo"), relative: `git/repositories/${name.slice(6)}` };
    if (name === "custom" || name.startsWith("custom/"))
      return { root: at("/forgejo"), relative: name };
    return fail();
  });
  await archive(at(`/input/${config.set}/openbao.snap`), [], () => null, true);
  for (const entry of w.objects) await verifyObjectInput(entry);
  if (config.verifyOnly) return;
  const identity = JSON.parse(await fs.readFile(at("/state/kubernetes-installation.json"), "utf8"));
  const expectedIdentity = {
    runtime: "substrate",
    namespace: config.source.namespace,
    release: config.source.release,
    factoryURL: config.source.factoryOrigin,
    forgeURL: config.source.forgejoOrigin,
    storageClass: config.source.storageClass,
  };
  check(
    Object.keys(identity).length === Object.keys(expectedIdentity).length &&
      Object.entries(expectedIdentity).every(([k, v]) => identity[k] === v),
  );
  for (const entry of w.objects) {
    const src = await verifyObjectInput(entry);
    const target = at(`/objects-input/${entry.path}`);
    await parents(target, at("/objects-input"));
    await fs.copyFile(src, target, 1);
    check((await fileHash(target)) === entry.sha256);
    await fs.chmod(target, 0o600);
  }
  for (const [name, uid, gid] of [
    ["postgres.dump", 999, 999],
    ["openbao.snap", 100, 1000],
  ] as const)
    await copyOwned(
      at(`/input/${config.set}/${name}`),
      at(`/control/${name}`),
      uid,
      gid,
      0o600,
      w.parts[name],
    );
  for (const [dir, uid, gid] of [
    ["/pg-data", 999, 999],
    ["/bao-data", 100, 1000],
    ["/objects-data", 1000, 1000],
  ] as const)
    await fs.chown(at(dir), uid, gid);
  await fs.chmod(at("/control"), 0o755);
  await fs.writeFile(at("/control/witnesses.json"), JSON.stringify(w), { mode: 0o600, flag: "wx" });
  await fs.writeFile(at("/control/pg-password"), randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
  await fs.chown(at("/control/pg-password"), 999, 999);
  await fs.mkdir(at("/control/tls"), { mode: 0o755 });
  for (const name of ["ca.crt", "tls.crt", "tls.key"])
    await copyOwned(
      at(`/input/tls/${name}`),
      at(`/control/tls/${name}`),
      100,
      1000,
      name === "tls.key" ? 0o600 : 0o644,
    );
  const baoConfig = {
    storage: { raft: { path: "/bao/data", node_id: "factory" } },
    api_addr: "https://127.0.0.1:8200",
    cluster_addr: "https://127.0.0.1:8201",
    listener: {
      tcp: {
        address: "127.0.0.1:8200",
        tls_cert_file: "/control/tls/tls.crt",
        tls_key_file: "/control/tls/tls.key",
      },
    },
    ui: false,
  };
  await fs.writeFile(at("/control/bao.json"), JSON.stringify(baoConfig), {
    mode: 0o644,
    flag: "wx",
  });
  const garageConfig = [
    'metadata_dir="/data/meta"',
    'data_dir="/data/blocks"',
    'db_engine="sqlite"',
    "replication_factor=1",
    'rpc_bind_addr="127.0.0.1:3901"',
    'rpc_public_addr="127.0.0.1:3901"',
    "[s3_api]",
    's3_region="garage"',
    'api_bind_addr="0.0.0.0:3900"',
    'root_domain=".objects.invalid"',
    "",
  ].join("\n");
  await fs.writeFile(at("/control/garage.toml"), garageConfig, { mode: 0o644, flag: "wx" });
  async function own(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      await fs.lchown(file, 1000, 1000);
    }
    await fs.chown(directory, 1000, 1000);
  }
  await own(at("/forgejo"));
  await own(at("/forgejo-config"));
}
