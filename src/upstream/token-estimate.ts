function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        if (part && typeof part === "object") return JSON.stringify(part);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function roughTokenCount(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  const nonCjk = text.replace(/[㐀-鿿]/g, "");
  const latinish = Math.ceil(nonCjk.length / 4);
  return Math.max(1, cjk + latinish);
}

export function estimateMessagesInputTokens(body: any): number {
  const parts: string[] = [];
  if (typeof body?.system === "string") parts.push(body.system);
  else if (Array.isArray(body?.system))
    parts.push(textFromContent(body.system));
  if (typeof body?.instructions === "string") parts.push(body.instructions);
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      parts.push(String(msg?.role || ""));
      parts.push(textFromContent(msg?.content));
      if (msg?.tool_calls) parts.push(JSON.stringify(msg.tool_calls));
    }
  }
  if (body?.input) parts.push(textFromContent(body.input));
  if (body?.tools) parts.push(JSON.stringify(body.tools));
  const total = roughTokenCount(parts.filter(Boolean).join("\n"));
  return Math.max(1, total);
}
