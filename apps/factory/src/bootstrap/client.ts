import type { Bootstrap } from "../api-contracts";
import { getBootstrap } from "../server-functions/bootstrap";
import { serverCall } from "../server-functions/result";

export function browserBootstrap(value: Bootstrap, development: boolean, origin: string) {
  if (!development) return value;
  const planning = new URL(value.zeroCacheURL);
  return {
    ...value,
    zeroCacheURL: `${origin}/__factory_zero${planning.pathname.replace(/\/$/, "")}`,
  };
}

export async function loadBootstrap() {
  return browserBootstrap(await serverCall(getBootstrap()), import.meta.env.DEV, location.origin);
}
