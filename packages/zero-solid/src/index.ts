import {
  type BaseDefaultContext,
  type BaseDefaultSchema,
  type CustomMutatorDefs,
  type ConnectionState,
  type DefaultContext,
  type DefaultSchema,
  type ErroredQuery,
  type HumanReadable,
  type PullRow,
  type QueryOrQueryRequest,
  type ReadonlyJSONValue,
  type ResultType,
  Zero,
  type ZeroOptions,
  type MaterializeOptions,
} from "@rocicorp/zero";
import { addContextToQuery, asQueryInternals } from "@rocicorp/zero/bindings";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import { listenToMaterializedView, ZeroClientLifecycle } from "./lifecycle";
import { createQueryData } from "./query-data";
import { createQuerySelection } from "./query-selection";

type AnyZero = Zero<BaseDefaultSchema, CustomMutatorDefs | undefined, BaseDefaultContext>;
type PreloadOptions = Parameters<AnyZero["preload"]>[1];
const ZeroContext = createContext<Accessor<AnyZero | undefined>>();

export function ZeroProvider<
  S extends BaseDefaultSchema = DefaultSchema,
  MD extends CustomMutatorDefs | undefined = undefined,
  C extends BaseDefaultContext = DefaultContext,
>(
  props: ParentProps<
    Omit<ZeroOptions<S, MD, C>, "batchViewUpdates" | "userID"> & {
      identity: { userId: string; schemaVersion: string; auth?: string } | null;
    }
  >,
) {
  const lifecycle = new ZeroClientLifecycle<Zero<S, MD, C>>();
  const client = createMemo(() =>
    lifecycle.select(props.identity, (identity) => {
      return new Zero<S, MD, C>({
        ...Object.fromEntries(
          Object.keys(props)
            .filter((key) => key !== "children" && key !== "identity")
            .map((key) => [key, Reflect.get(props, key)]),
        ),
        cacheURL: props.cacheURL,
        schema: props.schema,
        mutators: props.mutators,
        context: props.context,
        userID: identity.userId,
        auth: identity.auth,
        storageKey: `${props.storageKey ?? "factory"}:${identity.schemaVersion}`,
        batchViewUpdates: (update) => update(),
      } as ZeroOptions<S, MD, C>);
    }),
  );
  onCleanup(() => lifecycle.dispose());
  return ZeroContext({
    value: client as Accessor<AnyZero | undefined>,
    get children() {
      return props.children;
    },
  });
}

export function useZero<
  S extends BaseDefaultSchema = DefaultSchema,
  MD extends CustomMutatorDefs | undefined = undefined,
  C extends BaseDefaultContext = DefaultContext,
>() {
  const client = useContext(ZeroContext);
  if (!client) throw new Error("useZero must be called under ZeroProvider");
  return client as Accessor<Zero<S, MD, C> | undefined>;
}

export function useZeroQuery<
  S extends BaseDefaultSchema,
  TTable extends keyof S["tables"] & string,
  TInput extends ReadonlyJSONValue | undefined,
  TOutput extends ReadonlyJSONValue | undefined,
  TReturn = PullRow<TTable, S>,
  C extends BaseDefaultContext = BaseDefaultContext,
>(
  query: Accessor<QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, C> | null>,
  options?: MaterializeOptions,
) {
  const zero = useZero<S, undefined, C>();
  const { data, clear, publish } = createQueryData<HumanReadable<TReturn>>();
  const [completeness, setCompleteness] = createSignal<ResultType>("unknown");
  const [error, setError] = createSignal<ErroredQuery>();
  const [retry, setRetry] = createSignal(0);
  const selected = createQuerySelection(() => {
    const client = zero();
    const current = query();
    if (!client || !current) return undefined;
    const resolved = addContextToQuery(current, client.context);
    const internals = asQueryInternals(resolved);
    return {
      client,
      query: resolved,
      key: `${internals.hash()}:${JSON.stringify(internals.format)}`,
    };
  });
  createEffect(
    () => ({ selected: selected(), retry: retry() }),
    ({ selected: current }) => {
      clear();
      setCompleteness("unknown");
      setError(undefined);
      if (!current) return;
      const primaryKey =
        current.client.schema.tables[asQueryInternals(current.query).ast.table]?.primaryKey;
      if (!primaryKey) throw new Error("Zero query table is missing from the client schema");
      const view = current.client.materialize(current.query, options);
      const dispose = listenToMaterializedView(view, (next) => {
        publish(next.data, primaryKey);
        setCompleteness(next.completeness);
        setError(next.error);
      });
      if (untrack(data) === undefined) publish(view.data, primaryKey);
      return dispose;
    },
  );
  return { data, completeness, error, retry: () => setRetry((value) => value + 1) };
}

export function useZeroConnection() {
  const zero = useZero();
  const [state, setState] = createSignal<ConnectionState>();
  createEffect(zero, (client) => {
    setState(client?.connection.state.current);
    return client?.connection.state.subscribe(setState);
  });
  return { state, reconnect: () => zero()?.connection.connect() };
}

export function useZeroPreload<
  S extends BaseDefaultSchema,
  TTable extends keyof S["tables"] & string,
  TInput extends ReadonlyJSONValue | undefined,
  TOutput extends ReadonlyJSONValue | undefined,
  TReturn = PullRow<TTable, S>,
  C extends BaseDefaultContext = BaseDefaultContext,
>(
  query: Accessor<QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, C> | null>,
  options?: PreloadOptions,
) {
  const zero = useZero<S, undefined, C>();
  const selected = createQuerySelection(() => {
    const client = zero();
    const current = query();
    if (!client || !current) return undefined;
    const resolved = addContextToQuery(current, client.context);
    const internals = asQueryInternals(resolved);
    return {
      client,
      query: resolved,
      key: `${internals.hash()}:${JSON.stringify(internals.format)}`,
    };
  });
  createEffect(selected, (current) => {
    if (!current) return;
    const preload = current.client.preload(current.query, options);
    void preload.complete.catch(() => {});
    return preload.cleanup;
  });
}

export { ZeroClientLifecycle, listenToMaterializedView };
