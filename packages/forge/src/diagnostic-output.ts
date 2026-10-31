// Native logs stay in Forgejo. Keep a bounded, sanitized hint with its original
// byte cursor so correction can read the failure, not page through passing output.
const excerpt = (text: string, bytes: number) =>
  Buffer.from(text).subarray(0, bytes).toString("utf8");

export function sanitizeVerificationOutput(text: string, credential: string) {
  return (
    (credential ? text.replaceAll(credential, "<REDACTED>") : text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip native ANSI output.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        "<REDACTED PRIVATE KEY>",
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<REDACTED>@")
      .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_.=-]+/gi, "$1 <REDACTED>")
      .replace(
        /((?:["']?[\w.-]*(?:token|password|secret|api[_-]?key|credential)[\w.-]*["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1<REDACTED>",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve tabs and newlines only.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

function failurePriority(line: string) {
  const content = line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, "").trimStart();
  if (/^(?:[✔✓]|PASS\b)/.test(content)) return 0;
  // Passing negative cases can log expected application errors. Prefer actual
  // assertion/compiler failures, then test-runner failures, over those messages.
  if (/\bAssertionError\b|\bassertion failed\b|\berror TS\d+\b/i.test(content)) return 3;
  if (/^(?:[✖×]|FAIL(?:ED)?\b|not ok\b|--- FAIL:)/i.test(content)) return 2;
  return /\b(?:\w*Error|Exception)\b|\berror:|^(?:fatal|panic):|\bexit (?:status|code)\s*:?\s*[1-9]\d*/i.test(
    content,
  )
    ? 1
    : 0;
}

export async function readVerificationDiagnostic(response: Response, credential: string) {
  const range = response.headers.get("content-range")?.match(/^bytes 0-(\d+)\/(\d+)$/);
  if (response.status === 206 && (!range || Number(range[1]) + 1 !== Number(range[2]))) {
    await response.body?.cancel();
    throw new Error("Failed step log is not a complete native stream");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed step output is unavailable");
  let pending = Buffer.alloc(0),
    lineBytes = 0,
    lineStart = 0,
    total = 0,
    oversized = false,
    privateKey = false,
    short: string | null = "",
    tail = "";
  const recent: { offset: number; text: string }[] = [];
  const selection: {
    current: { priority: number; offset: number; text: string; remaining: number } | null;
  } = { current: null };
  function line(newline: boolean) {
    let text = oversized ? "[Overlong native log line omitted]" : pending.toString("utf8");
    const begin = /-----BEGIN [^-]*PRIVATE KEY-----/.test(text);
    const end = /-----END [^-]*PRIVATE KEY-----/.test(text);
    if (privateKey || begin) {
      privateKey = !end;
      text = "<REDACTED PRIVATE KEY>";
    }
    // Redact the complete bounded line before clipping any excerpt.
    text = `${excerpt(sanitizeVerificationOutput(text, credential), 1600)}\n`;
    if (short !== null) {
      short += text;
      if (Buffer.byteLength(short) > 2000) short = null;
    }
    tail = Buffer.from(tail + text)
      .subarray(-600)
      .toString("utf8");
    const priority = failurePriority(text);
    const selected = selection.current;
    if (priority > (selected?.priority ?? 0)) {
      selection.current = {
        priority,
        offset: recent[0]?.offset ?? lineStart,
        text: recent.map((item) => item.text).join("") + text,
        remaining: 12,
      };
    } else if (selected && selected.remaining > 0) {
      selected.text = excerpt(selected.text + text, 1500);
      selected.remaining--;
    }
    recent.push({ offset: lineStart, text: excerpt(text, 400) });
    if (recent.length > 3) recent.shift();
    lineStart += lineBytes + (newline ? 1 : 0);
    pending = Buffer.alloc(0);
    lineBytes = 0;
    oversized = false;
  }
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      total += bytes.length;
      for (let start = 0; start < bytes.length; ) {
        const boundary = bytes.indexOf(10, start);
        const end = boundary < 0 ? bytes.length : boundary;
        const part = bytes.subarray(start, end);
        lineBytes += part.length;
        if (lineBytes > 16 * 1024) {
          oversized = true;
          pending = Buffer.alloc(0);
        } else if (!oversized) pending = Buffer.concat([pending, part]);
        if (boundary < 0) break;
        line(true);
        start = boundary + 1;
      }
    }
    if (lineBytes) line(false);
    if (!total || (range && total !== Number(range[2])))
      throw new Error("Failed step log stream was empty or incomplete");
    if (short !== null) return short;
    const found = selection.current;
    return found
      ? `[Failure-looking output near native byte ${found.offset}; read this offset for full context]\n${excerpt(found.text, 1500)}\n[End of failed step output]\n${tail}`
      : `[No failure marker found in ${total} native bytes; read the step log for context]\n[End of failed step output]\n${tail}`;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
