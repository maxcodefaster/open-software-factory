import { expect, test } from "bun:test";
import { monitoringSignals } from "./payload";
import { fixtureValue } from "../../../../test/fixtures/value";

test("monitoring coalesces incident occurrences rather than transport or event IDs", () => {
  const sentry = {
    action: "created",
    data: {
      issue: {
        id: "42",
        title: "Null item",
        web_url: "https://errors.example/issues/42?token=private",
      },
      event: {
        event_id: "one",
        exception: { values: [{ type: "TypeError", value: "item is null" }] },
        request: { headers: { authorization: "secret" } },
        user: { email: "private@example.test" },
      },
    },
  };
  const first = fixtureValue(monitoringSignals(sentry)[0], "monitoringSignals(sentry)[0]");
  const repeated = fixtureValue(
    monitoringSignals({
      ...sentry,
      data: { ...sentry.data, event: { ...sentry.data.event, event_id: "two", timestamp: 200 } },
    })[0],
    'monitoringSignals({ ...sentry, data: { ...sentry.data, event: { ...sentry.data.event, event_id: "two", timestamp: 200 } ',
  );
  expect(first.fingerprint).toBe(repeated.fingerprint);
  expect(first.reference).toBe("https://errors.example/issues/42");
  expect(first.context).toContain("TypeError");
  expect(first.context).not.toContain("private");
  expect(first.context).not.toContain("secret");
  expect(
    fixtureValue(
      monitoringSignals({
        ...sentry,
        data: { ...sentry.data, issue: { ...sentry.data.issue, id: "43" } },
      })[0],
      'monitoringSignals({ ...sentry, data: { ...sentry.data, issue: { ...sentry.data.issue, id: "43" } }, })[0]',
    ).fingerprint,
  ).not.toBe(first.fingerprint);
});

test("grouped alerts retain individual fingerprints and ignore resolution notifications", () => {
  const signals = monitoringSignals({
    status: "firing",
    alerts: [
      {
        fingerprint: "a",
        labels: { alertname: "Bad response", pod: "app-a" },
        annotations: { summary: "Application error" },
      },
      { fingerprint: "b", labels: { alertname: "Bad response", pod: "app-b" }, status: "resolved" },
    ],
  });
  expect(signals).toHaveLength(2);
  expect(fixtureValue(signals[0], "signals[0]").title).toBe("Application error");
  expect(fixtureValue(signals[1], "signals[1]").ignored).toBe(true);
  expect(fixtureValue(signals[0], "signals[0]").fingerprint).not.toBe(
    fixtureValue(signals[1], "signals[1]").fingerprint,
  );
  expect(() => monitoringSignals({ alerts: Array.from({ length: 21 }, () => ({})) })).toThrow("20");
});

test("Azure alert cycles use the stable rule and target rather than a new alert ID", () => {
  const alert = (id: string, target: string) => ({
    data: {
      essentials: {
        alertId: id,
        alertRule: "Application exceptions",
        monitoringService: "Application Insights",
        alertTargetIDs: [target],
        monitorCondition: "Fired",
        firedDateTime: id,
      },
    },
  });
  expect(
    fixtureValue(
      monitoringSignals(alert("first", "resource"))[0],
      'monitoringSignals(alert("first", "resource"))[0]',
    ).fingerprint,
  ).toBe(
    fixtureValue(
      monitoringSignals(alert("second", "resource"))[0],
      'monitoringSignals(alert("second", "resource"))[0]',
    ).fingerprint,
  );
  expect(
    fixtureValue(
      monitoringSignals(alert("first", "resource"))[0],
      'monitoringSignals(alert("first", "resource"))[0]',
    ).fingerprint,
  ).not.toBe(
    fixtureValue(
      monitoringSignals(alert("first", "other"))[0],
      'monitoringSignals(alert("first", "other"))[0]',
    ).fingerprint,
  );
});

test("generic alerts retain bounded diagnostic data, not arbitrary payloads or callback authority", () => {
  const signal = fixtureValue(
    monitoringSignals({
      title: "Invalid invoice",
      context: { token: "secret", user: { name: "Private person" }, stack: "x".repeat(100_000) },
      callback: "https://internal.invalid",
      projectId: "must-not-route",
      NewStateValue: "ALARM",
    })[0],
    'monitoringSignals({ title: "Invalid invoice", context: { token: "secret", user: { name: "Private person" }, stack: "x".r',
  );
  expect(signal.context.length).toBeLessThanOrEqual(16_000);
  expect(signal.context).not.toContain("secret");
  expect(signal.context).not.toContain("Private person");
  expect(signal.context).not.toContain("must-not-route");
  expect(signal.context).not.toContain("internal");
  expect(
    monitoringSignals({ Type: "SubscriptionConfirmation", SubscribeURL: "https://internal" }),
  ).toEqual([]);
  expect(
    fixtureValue(
      monitoringSignals({
        Type: "Notification",
        Message: JSON.stringify({
          AlarmName: "Application alarm",
          AlarmArn: "owned-alarm",
          NewStateValue: "OK",
        }),
      })[0],
      'monitoringSignals({ Type: "Notification", Message: JSON.stringify({ AlarmName: "Application alarm", AlarmArn: "owned-ala',
    ).ignored,
  ).toBe(true);
  expect(() => monitoringSignals([])).toThrow("JSON object");
  expect(() => monitoringSignals({ Type: "Notification", Message: "not JSON" })).toThrow(
    "JSON alert",
  );
});

test("generic requests retain message bodies and distinguish content while stable IDs coalesce", () => {
  const request = {
    title: "Product feedback",
    body: { text: "Improve exports", token: "private" },
  };
  const first = fixtureValue(monitoringSignals(request)[0], "monitoringSignals(request)[0]");
  expect(first.context).toContain("Improve exports");
  expect(first.context).not.toContain("private");
  expect(
    fixtureValue(
      monitoringSignals({ ...request, timestamp: "later" })[0],
      'monitoringSignals({ ...request, timestamp: "later" })[0]',
    ).fingerprint,
  ).toBe(first.fingerprint);
  expect(
    fixtureValue(
      monitoringSignals({ ...request, body: { text: "Improve search" } })[0],
      'monitoringSignals({ ...request, body: { text: "Improve search" } })[0]',
    ).fingerprint,
  ).not.toBe(first.fingerprint);
  expect(
    fixtureValue(
      monitoringSignals({ ...request, id: "owned-42" })[0],
      'monitoringSignals({ ...request, id: "owned-42" })[0]',
    ).fingerprint,
  ).toBe(
    fixtureValue(
      monitoringSignals({ title: "Changed description", id: "owned-42" })[0],
      'monitoringSignals({ title: "Changed description", id: "owned-42" })[0]',
    ).fingerprint,
  );
});

test("plain-text Input requests survive redaction without retaining HTTP request metadata", () => {
  const request =
    "Show the remaining-task count above the list, independent of its filter. " +
    "Update it after adding, completing, reopening or deleting a task.";
  const first = fixtureValue(
    monitoringSignals({
      title: "Task feedback",
      context: {
        request,
        token: "private-token-sentinel",
        user: { email: "private-user-sentinel" },
      },
      request: {
        headers: { authorization: "private-auth-sentinel" },
        body: "private-http-body-sentinel",
      },
    })[0],
    'monitoringSignals({ title: "Task feedback", context: { request, token: "private-token-sentinel", user: { email: "private',
  );
  expect(JSON.parse(first.context).context.request).toBe(request);
  expect(first.context).not.toContain("private-");
  expect(JSON.parse(first.context).payload).not.toHaveProperty("request");
  expect(
    fixtureValue(
      monitoringSignals({
        title: "Task feedback",
        context: { request: "Show the completed-task count below the list." },
      })[0],
      'monitoringSignals({ title: "Task feedback", context: { request: "Show the completed-task count below the list." }, })[0]',
    ).fingerprint,
  ).not.toBe(first.fingerprint);
});

test("plain-text request fields keep the existing text and URL bounds", () => {
  const first = fixtureValue(
    monitoringSignals({
      title: "Request context",
      request: "x".repeat(3_000),
      context: { Request: "https://source.example/feedback?token=private#private" },
    })[0],
    'monitoringSignals({ title: "Request context", request: "x".repeat(3_000), context: { Request: "https://source.example/fe',
  );
  const context = JSON.parse(first.context);
  expect(context.payload.request).toBe("x".repeat(2_000));
  expect(context.context.Request).toBe("https://source.example/feedback");
  expect(first.context).not.toContain("private");
});
