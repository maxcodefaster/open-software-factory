import { expect, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  describeFailure,
  type LogContext,
  logEvent,
  logFailure,
  redactSecrets,
  reportFailure,
} from "./failure-log";

function withLogFormat(value: string | undefined, fn: () => void) {
  const previous = process.env["FACTORY_LOG_FORMAT"];
  if (value === undefined) delete process.env["FACTORY_LOG_FORMAT"];
  else process.env["FACTORY_LOG_FORMAT"] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env["FACTORY_LOG_FORMAT"];
    else process.env["FACTORY_LOG_FORMAT"] = previous;
  }
}

test("failure descriptions keep the cause chain and drop credentials", () => {
  const cause = new Error("upstream said no", {
    cause: new Error("GET https://u:hunter2@forge/x?factory-grant=abc123&ok=1"),
  });
  const text = describeFailure(cause);
  expect(text).toContain("upstream said no");
  expect(text).toContain("caused by Error");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("abc123");
  expect(text).toContain("ok=1");
  expect(describeFailure("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain(
    "abcdefghij",
  );
  expect(describeFailure("x".repeat(5000)).length).toBeLessThan(2100);
});

test("reported failures reach the log with their context", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportFailure("release reconcile")(new Error("boom"));
    expect(String(log.mock.calls[0]?.[0])).toContain("release reconcile: Error: boom");
  } finally {
    log.mockRestore();
  }
});

test("database failure logs retain SQLSTATE and stack without query text or parameter values", () => {
  const cause = Object.assign(new Error("private-error-detail"), { code: "40P01" });
  const failure = new DrizzleQueryError(
    'select "owner_token" from "factory"."agent_turn" where "owner_token" = $1',
    ["private-lease", "private-provider-key"],
    cause,
  );
  const text = describeFailure(failure);
  expect(text).toContain("40P01");
  expect(text).toContain("at ");
  expect(text).not.toContain("private-");
  expect(text).not.toContain("owner_token");
});

test("redactSecrets scrubs x-api-key, cookie, and set-cookie headers in text and JSON", () => {
  const plain = [
    "X-API-Key: sk-live-secret-999",
    "Cookie: __Host-session=sess-secret-123; theme=dark",
    "Set-Cookie: __Host-session=new-secret-456; Path=/; HttpOnly; Secure",
    "X-Request-Id: req-visible",
  ].join("\n");
  const redactedPlain = redactSecrets(plain);
  expect(redactedPlain).not.toContain("sk-live-secret-999");
  expect(redactedPlain).not.toContain("sess-secret-123");
  expect(redactedPlain).not.toContain("new-secret-456");
  expect(redactedPlain).toContain("X-API-Key: [redacted]");
  expect(redactedPlain).toContain("Cookie: [redacted]");
  expect(redactedPlain).toContain("Set-Cookie: [redacted]");
  expect(redactedPlain).toContain("X-Request-Id: req-visible");

  const serialized = JSON.stringify({
    "x-api-key": "sk-json-secret",
    cookie: "sid=json-cookie-secret; note=it's",
    "set-cookie": ["sid=array-secret; HttpOnly", "csrf=array-csrf"],
    authorization: "Basic dXNlcjpwYXNz",
    requestId: "req-json-visible",
  });
  const redactedJson = redactSecrets(serialized);
  expect(redactedJson).not.toContain("sk-json-secret");
  expect(redactedJson).not.toContain("json-cookie-secret");
  expect(redactedJson).not.toContain("array-secret");
  expect(redactedJson).not.toContain("array-csrf");
  expect(redactedJson).not.toContain("dXNlcjpwYXNz");
  expect(redactedJson).toContain('"requestId":"req-json-visible"');
});

test("logFailure and reportFailure include correlation metadata in human-readable mode", () => {
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    withLogFormat(undefined, () => {
      const meta: LogContext = {
        requestId: "req-1",
        attemptId: "att-2",
        changeId: "chg-3",
        workspaceId: "ws-4",
        projectId: "proj-5",
        userId: "usr-6",
        component: "runtime controller",
        actorId: undefined,
        releaseId: null,
      };
      logFailure("workspace resume", new Error("actor unreachable"), meta);
      reportFailure("release sync", { projectId: "proj-9", requestId: "req-9" })(
        new Error("sync timeout"),
      );
    });

    const first = String(errorLog.mock.calls[0]?.[0]);
    expect(first).toStartWith("[factory] workspace resume ");
    expect(first).toContain("requestId=req-1");
    expect(first).toContain("attemptId=att-2");
    expect(first).toContain("changeId=chg-3");
    expect(first).toContain("workspaceId=ws-4");
    expect(first).toContain("projectId=proj-5");
    expect(first).toContain("userId=usr-6");
    expect(first).toContain('component="runtime controller"');
    expect(first).not.toContain("actorId");
    expect(first).not.toContain("releaseId");
    expect(first).toContain(": Error: actor unreachable");

    const second = String(errorLog.mock.calls[1]?.[0]);
    expect(second).toContain(
      "[factory] release sync projectId=proj-9 requestId=req-9: Error: sync timeout",
    );
  } finally {
    errorLog.mockRestore();
  }
});

test("logEvent routes info, warn, and error levels with human-readable output by default", () => {
  const infoLog = spyOn(console, "info").mockImplementation(() => {});
  const warnLog = spyOn(console, "warn").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    withLogFormat(undefined, () => {
      logEvent("info", "workspace.resumed", { workspaceId: "ws-1", durationMs: 42 });
      logEvent("warn", "runtime.slow", { component: "runtime", attemptId: "att-7" });
      logEvent("error", "verification.failed", {
        changeId: "chg-8",
        cause: new Error("exit code 1"),
      });
    });

    expect(String(infoLog.mock.calls[0]?.[0])).toBe(
      "[factory] workspace.resumed workspaceId=ws-1 durationMs=42",
    );
    expect(String(warnLog.mock.calls[0]?.[0])).toBe(
      "[factory] runtime.slow component=runtime attemptId=att-7",
    );
    expect(String(errorLog.mock.calls[0]?.[0])).toContain(
      "[factory] verification.failed changeId=chg-8: Error: exit code 1",
    );
  } finally {
    infoLog.mockRestore();
    warnLog.mockRestore();
    errorLog.mockRestore();
  }
});

test("JSON log mode emits compact, redacted, bounded structured entries across fields and nested causes", () => {
  const infoLog = spyOn(console, "info").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    withLogFormat("json", () => {
      logEvent("info", "http.request GET /hook?token=event-secret-1", {
        requestId: "req-json-1",
        projectId: "proj-json-2",
        component: "gateway",
        durationMs: 18,
        path: "/callback?api_key=path-secret-2&ok=1",
        headerPreview: "X-Api-Key: hdr-secret-3\nCookie: sid=cookie-secret-4\nHost: factory.local",
        cookie: "direct-cookie-secret-5",
        longField: "z".repeat(1000),
        level: "spoofed",
        event: "spoofed",
        timestamp: "spoofed",
      });

      const nested = new Error(
        "outer failed with Set-Cookie: sid=nested-cookie-secret-6; HttpOnly",
        {
          cause: new Error("inner failed with X-Api-Key: nested-api-secret-7", {
            cause: {
              headers: { cookie: "deep-cookie-secret-8", "x-api-key": "deep-key-secret-9" },
            },
          }),
        },
      );
      reportFailure("upstream call", {
        requestId: "req-json-2",
        workspaceId: "ws-json-3",
        userId: "usr-json-4",
      })(nested);
    });

    const infoLine = String(infoLog.mock.calls[0]?.[0]);
    expect(infoLine).not.toContain("\n");
    expect(infoLine).not.toContain("event-secret-1");
    expect(infoLine).not.toContain("path-secret-2");
    expect(infoLine).not.toContain("hdr-secret-3");
    expect(infoLine).not.toContain("cookie-secret-4");
    expect(infoLine).not.toContain("direct-cookie-secret-5");

    const parsedInfo = JSON.parse(infoLine) as Record<string, unknown>;
    expect(typeof parsedInfo["timestamp"]).toBe("string");
    expect(parsedInfo["level"]).toBe("info");
    expect(parsedInfo["event"]).toBe("http.request GET /hook?token=[redacted]");
    expect(parsedInfo["requestId"]).toBe("req-json-1");
    expect(parsedInfo["projectId"]).toBe("proj-json-2");
    expect(parsedInfo["component"]).toBe("gateway");
    expect(parsedInfo["durationMs"]).toBe(18);
    expect(parsedInfo["path"]).toBe("/callback?api_key=[redacted]&ok=1");
    expect(parsedInfo["headerPreview"]).toBe(
      "X-Api-Key: [redacted] Cookie: [redacted] Host: factory.local",
    );
    expect(parsedInfo["cookie"]).toBe("[redacted]");
    expect(String(parsedInfo["longField"]).length).toBeLessThanOrEqual(257);
    expect(parsedInfo["cause"]).toBeUndefined();

    const errorLine = String(errorLog.mock.calls[0]?.[0]);
    expect(errorLine).not.toContain("\n");
    expect(errorLine).not.toContain("nested-cookie-secret-6");
    expect(errorLine).not.toContain("nested-api-secret-7");
    expect(errorLine).not.toContain("deep-cookie-secret-8");
    expect(errorLine).not.toContain("deep-key-secret-9");

    const parsedError = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsedError["level"]).toBe("error");
    expect(parsedError["event"]).toBe("upstream call");
    expect(parsedError["requestId"]).toBe("req-json-2");
    expect(parsedError["workspaceId"]).toBe("ws-json-3");
    expect(parsedError["userId"]).toBe("usr-json-4");
    expect(String(parsedError["cause"])).toContain("outer failed with Set-Cookie: [redacted]");
    expect(String(parsedError["cause"])).toContain("inner failed with X-Api-Key: [redacted]");
    expect(String(parsedError["cause"])).toContain('"cookie":"[redacted]"');
    expect(String(parsedError["cause"])).toContain('"x-api-key":"[redacted]"');
  } finally {
    infoLog.mockRestore();
    errorLog.mockRestore();
  }
});
