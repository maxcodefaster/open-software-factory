import type { FactoryProtocols } from "./protocols";

// Keep Start's injected host context at the framework boundary. The RC route
// generics do not carry the optional fetch context through every parent route.
export function factoryProtocolContext(context: unknown): FactoryProtocols {
  const protocols = (context as { protocols?: FactoryProtocols } | undefined)?.protocols;
  if (!protocols) throw new Response("Factory host unavailable", { status: 503 });
  return protocols;
}
