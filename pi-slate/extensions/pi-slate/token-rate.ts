export const TOKEN_RATE_WINDOW_MS = 5000;
export const TOKEN_RATE_MIN_ELAPSED_MS = 250;

export type AssistantContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type Sample = { t: number; tokens: number };

export function estimateAssistantTokens(message: { content?: readonly AssistantContentBlock[] }): number {
  const content = message.content;
  if (!content) return 0;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text?.length ?? 0;
    else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
  }
  return chars / 4;
}

export class TokenRateTracker {
  private samples: Sample[] = [];
  private lastPartialTokens = 0;
  private streaming = false;
  private lastRate = 0;
  private activeNow = 0;
  private lastWall: number | null = null;
  private onChange?: () => void;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  setOnChange(callback: (() => void) | undefined): void {
    this.onChange = callback;
  }

  startMessage(): void {
    this.lastPartialTokens = 0;
    this.samples = [];
    this.activeNow = 0;
    this.streaming = true;
    this.lastWall = this.now();
  }

  observePartial(tokens: number): void {
    if (!this.streaming) this.startMessage();
    const next = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    const delta = Math.max(0, next - this.lastPartialTokens);
    this.lastPartialTokens = next;
    if (delta <= 0) return;
    this.syncClock();
    this.samples.push({ t: this.activeNow, tokens: delta });
    this.prune();
    this.lastRate = this.liveRate(TOKEN_RATE_MIN_ELAPSED_MS);
    this.onChange?.();
  }

  endMessage(): void {
    if (this.streaming) {
      this.syncClock();
      this.prune();
      if (this.samples.length > 0) this.lastRate = this.liveRate(1);
    }
    this.lastPartialTokens = 0;
    this.streaming = false;
    this.lastWall = null;
    this.onChange?.();
  }

  rate(): number {
    if (!this.streaming) return this.lastRate;
    this.syncClock();
    this.prune();
    if (this.samples.length === 0) return this.lastRate;
    this.lastRate = this.liveRate(TOKEN_RATE_MIN_ELAPSED_MS);
    return this.lastRate;
  }

  dispose(): void {
    this.samples = [];
    this.lastPartialTokens = 0;
    this.streaming = false;
    this.lastRate = 0;
    this.activeNow = 0;
    this.lastWall = null;
    this.onChange = undefined;
  }

  private liveRate(minElapsedMs: number): number {
    if (this.samples.length === 0) return 0;
    let tokens = 0;
    for (const sample of this.samples) tokens += sample.tokens;
    const elapsedMs = Math.min(
      TOKEN_RATE_WINDOW_MS,
      Math.max(this.activeNow - this.samples[0]!.t, minElapsedMs),
    );
    return tokens / (elapsedMs / 1000);
  }

  private syncClock(): void {
    const wall = this.now();
    if (this.streaming && this.lastWall !== null) {
      this.activeNow += Math.max(0, wall - this.lastWall);
    }
    this.lastWall = wall;
  }

  private prune(): void {
    const cutoff = this.activeNow - TOKEN_RATE_WINDOW_MS;
    let index = 0;
    while (index < this.samples.length && this.samples[index]!.t < cutoff) index++;
    if (index > 0) this.samples = this.samples.slice(index);
  }

}
