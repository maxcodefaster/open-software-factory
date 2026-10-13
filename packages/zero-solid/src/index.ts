import {
  type BaseDefaultContext,
  type BaseDefaultSchema,
  type CustomMutatorDefs,
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
} from "@rocicorp/zero";
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

type AnyZero = Zero<BaseDefaultSchema, CustomMutatorDefs | undefined, BaseDefaultContext>;
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
>(query: Accessor<QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, C> | null>) {
  const zero = useZero<S, undefined, C>();
  const [data, setData] = createSignal<HumanReadable<TReturn>>();
  const [completeness, setCompleteness] = createSignal<ResultType>("unknown");
  const [error, setError] = createSignal<ErroredQuery>();
  createEffect(
    () => ({ client: zero(), query: query() }),
    ({ client, query: current }) => {
      setData(undefined);
      setCompleteness("unknown");
      setError(undefined);
      if (!client || !current) return;
      const view = client.materialize(current);
      const dispose = listenToMaterializedView(view, (next) => {
        setData(() => next.data);
        setCompleteness(next.completeness);
        setError(next.error);
      });
      if (untrack(data) === undefined) setData(() => view.data);
      return dispose;
    },
  );
  return { data, completeness, error };
}

export { ZeroClientLifecycle, listenToMaterializedView };
