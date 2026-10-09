import type { AssistantContentBlock } from "./token-rate.ts";

export function formatLiveThinking(word: string, elapsedMs: number | null, rate: number | null): string {
  const parts = [word];
  if (elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs >= 1000) {
    parts.push(`${Math.floor(elapsedMs / 1000)}s`);
  }
  if (rate !== null && Number.isFinite(rate) && rate >= 0) parts.push(`↑↓${Math.round(rate)}`);
  return parts.join(" · ");
}

type ScheduleTick = (tick: () => void) => () => void;

function scheduleTick(tick: () => void): () => void {
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Only time observed thinking_start/end pairs; never guess durations from restored content. */
export class ThinkingFoldTracker {
  private disposed = false;
  private startedAt: number | null = null;
  private contentIndex: number | null = null;
  private cancelTick?: () => void;
  private onChange?: () => void;
  private readonly now: () => number;
  private readonly schedule: ScheduleTick;

  constructor(options: { now?: () => number; schedule?: ScheduleTick; onChange?: () => void } = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTick;
    this.onChange = options.onChange;
  }

  elapsedMs(): number | null {
    return this.startedAt === null ? null : Math.max(0, this.now() - this.startedAt);
  }

  observe(event: unknown, message: { content?: readonly AssistantContentBlock[] }): void {
    if (this.disposed) return;
    if (typeof event !== "object" || event === null) {
      this.stop();
      return;
    }
    const { type, contentIndex } = event as { type?: unknown; contentIndex?: unknown };
    if (typeof type !== "string") {
      this.stop();
      return;
    }
    if (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end") {
      if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex)
        || contentIndex < 0 || message.content?.[contentIndex]?.type !== "thinking") {
        this.stop();
        return;
      }
      if (type === "thinking_start") {
        if (this.contentIndex === contentIndex) return;
        this.stop();
        this.contentIndex = contentIndex;
        this.startedAt = this.now();
        this.cancelTick = this.schedule(() => this.onChange?.());
        this.onChange?.();
      } else if (type === "thinking_end" || contentIndex !== this.contentIndex) {
        this.stop();
      }
    } else {
      // Missing thinking_end or a changed event shape must not leave a live timer behind.
      this.stop();
    }
  }

  stop(): void {
    const wasActive = this.startedAt !== null;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.startedAt = null;
    this.contentIndex = null;
    if (wasActive) this.onChange?.();
  }

  dispose(): void {
    this.disposed = true;
    this.onChange = undefined;
    this.stop();
  }
}
