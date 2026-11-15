import type { Sql } from "postgres";

/** Observe only this controlled operation; normal SQL still reaches the owned database. */
export function guardWriterCoordination(create: () => Sql) {
  const held = new Map<string, symbol>();
  let acquisitions = 0;
  return {
    get acquisitions() {
      return acquisitions;
    },
    get heldKeys() {
      return [...held.keys()];
    },
    coordination() {
      const connection = create();
      const owner = Symbol("owned coordination connection");
      return new Proxy(connection, {
        apply(target, thisArg, args) {
          const [parts, key] = args;
          const statement = Array.isArray(parts) ? parts.join("?").trim() : "";
          const lock = statement === "SELECT pg_advisory_lock(hashtext(?))";
          const unlock = statement === "SELECT pg_advisory_unlock(hashtext(?))";
          if ((!lock && !unlock) || typeof key !== "string")
            return Reflect.apply(target, thisArg, args);
          if (lock && held.has(key)) throw new Error("Reentrant writer coordination lock");
          return Promise.resolve(Reflect.apply(target, thisArg, args)).then((result) => {
            if (lock) {
              held.set(key, owner);
              acquisitions++;
            } else if (held.get(key) === owner) {
              held.delete(key);
            }
            return result;
          });
        },
        get(target, property, receiver) {
          if (property !== "end") return Reflect.get(target, property, receiver);
          return async (options?: { timeout?: number }) => {
            try {
              await target.end(options);
            } finally {
              for (const [key, holder] of held) if (holder === owner) held.delete(key);
            }
          };
        },
      });
    },
  };
}
