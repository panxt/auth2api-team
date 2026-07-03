import { createHmac } from "crypto";

/**
 * 飞书 (Lark) custom-bot webhook sender. Posts an interactive card (or plain
 * text) to an incoming-webhook URL, with optional HMAC-SHA256 signing (加签).
 *
 * This is the ONLY module that performs external egress for notifications;
 * callers gate it behind NotifyConfig.enabled. All failures are surfaced to the
 * caller (which swallows them) so a broken webhook never affects the main flow.
 */

export interface FeishuCardField {
  label: string;
  value: string;
}

/** Build a飞书 interactive card payload from a title + labeled fields. */
export function buildCard(
  title: string,
  fields: FeishuCardField[],
  color: "red" | "orange" | "green" | "grey" = "orange",
): unknown {
  const content = fields
    .map((f) => `**${f.label}:** ${f.value}`)
    .join("\n");
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: title },
        template: color,
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content } }],
    },
  };
}

/**
 * 飞书 signature: base64( HMAC-SHA256( key = `${timestamp}\n${secret}`, msg = "" ) ).
 * Note飞书's scheme uses the "timestamp\nsecret" string as the HMAC KEY over an
 * empty message — matches the official docs.
 */
function sign(secret: string, timestamp: number): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

/** POST a payload to the飞书 webhook. Throws on network / non-2xx / 飞书 error. */
export async function sendFeishu(
  webhookUrl: string,
  secret: string,
  payload: any,
  timeoutMs = 8000,
): Promise<void> {
  if (!webhookUrl) throw new Error("feishu webhook-url not configured");
  const body: any = { ...payload };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = sign(secret, ts);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`feishu HTTP ${resp.status}: ${text.slice(0, 200)}`);
    // 飞书 returns {code:0,...} on success; non-zero code = logical error even on
    // HTTP 200. Parse defensively (a non-JSON 2xx body is treated as success),
    // but a parsed non-zero code MUST surface — keep it out of the parse catch.
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // non-JSON 2xx — treat as success
    }
    if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
      throw new Error(`feishu code ${parsed.code}: ${parsed.msg || text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}
