import type { Bootstrap } from "../api-contracts";

export function browserBootstrap(value: Bootstrap, development: boolean, origin: string) {
  if (!development) return value;
  const planning = new URL(value.zeroCacheURL);
  return {
    ...value,
    zeroCacheURL: `${origin}/__factory_zero${planning.pathname.replace(/\/$/, "")}`,
  };
}
