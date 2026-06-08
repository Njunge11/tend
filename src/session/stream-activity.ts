type ContentBlock = { type?: string; name?: string; input?: Record<string, unknown> };
type StreamEvent = { type?: string; message?: { content?: ContentBlock[] } };

export type StreamActivityScanner = {
  /** Feed a raw stdout chunk; complete NDJSON lines are parsed as they arrive. */
  push(chunk: string): void;
  /** Signal end-of-stream; attempts to parse any trailing partial line. */
  end(): void;
};

/** A short human label for one stream event's activity, or null for non-activity events. */
function activityLabels(event: StreamEvent): string[] {
  if (event.type !== "assistant") return [];
  const labels: string[] = [];
  for (const block of event.message?.content ?? []) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      const path = block.input?.["file_path"];
      labels.push(typeof path === "string" ? `${block.name} ${path}` : block.name);
    } else if (block.type === "text") {
      labels.push("thinking");
    }
  }
  return labels;
}

/**
 * Incremental consumer for Claude Code `--output-format stream-json` stdout. Buffers
 * partial lines across chunks and reports a short activity label per assistant event
 * (tool uses with their target file, text turns as "thinking"). Malformed or truncated
 * lines are skipped — this is progress decoration only and must never throw; the
 * authoritative outcome is still judged from the disk after the session ends.
 */
export function createStreamActivityScanner(
  onActivity: (activity: string) => void,
): StreamActivityScanner {
  let buffer = "";
  let last: string | undefined;

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      return;
    }
    for (const label of activityLabels(event)) {
      if (label === last) continue;
      last = label;
      onActivity(label);
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    end(): void {
      consume(buffer);
      buffer = "";
    },
  };
}
