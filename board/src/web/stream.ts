import type { Snapshot } from "../store/web";

export interface StreamOptions {
  marker: () => Promise<string>;
  snapshot: () => Promise<Snapshot>;
  tickMs: number;
  heartbeatMs: number;
  maxMs: number;
  now: () => number;
  /** Called exactly once when the stream ends for any reason (client left, lifetime reached, error). */
  onClose?: () => void;
}

const encoder = new TextEncoder();
const frame = (snapshot: Snapshot): Uint8Array => encoder.encode(`id: ${snapshot.marker}\nevent: changed\ndata: ${JSON.stringify(snapshot)}\n\n`);
const COMMENT = encoder.encode(": heartbeat\n\n");

class Pump {
  private lastMarker: string | null = null;
  private readonly startedAt: number;
  private lastSentAt: number;
  private wake: (() => void) | null = null;
  closed = false;

  constructor(private readonly opts: StreamOptions) {
    this.startedAt = opts.now();
    this.lastSentAt = this.startedAt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private finished = false;

  /** Idempotent: runs the close hook once. */
  finish(): void {
    this.closed = true;
    this.wake?.();
    if (!this.finished) {
      this.finished = true;
      this.opts.onClose?.();
    }
  }

  cancel(): void {
    this.finish();
  }

  private send(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): true {
    controller.enqueue(chunk);
    this.lastSentAt = this.opts.now();
    return true;
  }

  /** One check. Returns true once it has enqueued something or closed the stream (pull must not return before that). */
  async step(controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> {
    if (this.lastMarker === null) {
      const snap = await this.opts.snapshot();
      if (this.closed) return true;
      this.lastMarker = snap.marker;
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      return this.send(controller, frame(snap));
    }
    await this.sleep(this.opts.tickMs);
    if (this.closed) return true;
    if (this.opts.now() - this.startedAt >= this.opts.maxMs) {
      controller.close();
      this.finish();
      return true;
    }
    const marker = await this.opts.marker();
    if (this.closed) return true;
    if (marker !== this.lastMarker) {
      const snap = await this.opts.snapshot();
      if (this.closed) return true;
      this.lastMarker = snap.marker;
      return this.send(controller, frame(snap));
    }
    return this.opts.now() - this.lastSentAt >= this.opts.heartbeatMs ? this.send(controller, COMMENT) : false;
  }
}

/**
 * Server-Sent Events from a pull-based ReadableStream (works in Workers and Node). It sends the
 * snapshot at once, then checks the cheap change marker every `tickMs` and sends a new snapshot only
 * when it moved. A comment goes out every `heartbeatMs` and the stream ends after `maxMs`;
 * EventSource reconnects by itself. Pull-based, so nothing is read from the database while nobody consumes.
 */
export function eventStream(opts: StreamOptions): ReadableStream<Uint8Array> {
  const pump = new Pump(opts);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!pump.closed && !(await pump.step(controller)));
      } catch (err) {
        console.error("board stream failure", err instanceof Error ? err.message : "unknown");
        if (!pump.closed) controller.close();
        pump.finish();
      }
    },
    cancel() {
      pump.cancel();
    },
  });
}
