import type postgres from "postgres";
import type { createDatabase } from "#db/client";

export type ConversationStatement = {
  text: string;
  parameters: unknown[];
  transaction: number | null;
};

// Replace database I/O only. The owner queries and Drizzle's
// builders/result mapping still run; unexpected statements fail each test.
export function conversationDatabase(
  raw: (statement: ConversationStatement) => unknown[] | Promise<unknown[]>,
  typed: (statement: ConversationStatement) => unknown[][] | Promise<unknown[][]> = ({ text }) => {
    throw new Error(`Unexpected typed Conversation query: ${text}`);
  },
) {
  const statements: ConversationStatement[] = [];
  let transactions = 0;
  function connection(transaction: number | null) {
    return Object.assign(
      (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        const statement = {
          text: strings.join("?").replace(/\s+/g, " ").trim(),
          parameters,
          transaction,
        };
        statements.push(statement);
        return Promise.resolve(raw(statement));
      },
      {
        unsafe(text: string, parameters: unknown[]) {
          const statement = { text, parameters, transaction };
          statements.push(statement);
          const rows = typed(statement);
          return Object.assign(Promise.resolve(rows), { values: async () => rows });
        },
      },
    );
  }
  const client = Object.assign(connection(null), {
    async begin<T>(work: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
      return work(connection(++transactions) as unknown as postgres.TransactionSql);
    },
  });
  const database = {
    client,
    coordination() {
      throw new Error("Conversation persistence must not open a coordination connection");
    },
  } as unknown as ReturnType<typeof createDatabase>;
  return { database, statements, transactions: () => transactions };
}
