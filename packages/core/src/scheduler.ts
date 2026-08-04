export class CompletionScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #abort: AbortController | null = null;
  constructor(private run: (signal: AbortSignal) => Promise<void>, private debounceMs = 150) {}

  trigger() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#timer = setTimeout(() => {
      this.#abort = new AbortController();
      void this.run(this.#abort.signal);
    }, this.debounceMs);
  }

  cancel() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort?.abort();
  }
}
