export interface Watcher {
  stop(): void;
}

/** Duck type for Chrome's experimental FileSystemObserver instances. */
export interface FileSystemObserverLike {
  observe?(...args: unknown[]): unknown;
  disconnect?(): void;
}

type ChangeRecord = {
  relativePathComponents?: string[];
  changedHandle?: { name?: string };
};

/** Constructor shape for FileSystemObserver (global or injected). */
export type FileSystemObserverCtor = new (
  callback: (records: ChangeRecord[]) => void,
) => FileSystemObserverLike;

function pathFromRecord(record: ChangeRecord): string | null {
  if (record.relativePathComponents && record.relativePathComponents.length > 0) {
    return record.relativePathComponents.join("/");
  }
  return record.changedHandle?.name ?? null;
}

function safeDisconnect(obs: FileSystemObserverLike): void {
  try {
    obs.disconnect?.();
  } catch {
    // no-op-safe disconnect
  }
}

/**
 * Start observing `root` if the constructor yields an instance with `observe`.
 * Returns null when observing cannot be started so the caller can poll instead.
 */
function tryStartObserver(
  Ctor: FileSystemObserverCtor,
  onChanged: (path: string) => void,
  root: unknown,
): Watcher | null {
  let obs: FileSystemObserverLike;
  try {
    obs = new Ctor((records) => {
      for (const record of records) {
        const path = pathFromRecord(record);
        if (path != null && path !== "") onChanged(path);
      }
    });
  } catch {
    return null;
  }

  if (typeof obs.observe !== "function") {
    safeDisconnect(obs);
    return null;
  }

  try {
    void obs.observe(root);
  } catch {
    safeDisconnect(obs);
    return null;
  }

  return {
    stop() {
      safeDisconnect(obs);
    },
  };
}

function startPoll(
  ws: { tree(): Promise<Array<{ path: string }>> },
  onChanged: (path: string) => void,
  intervalMs: number,
): Watcher {
  let stopped = false;
  let prev: Set<string> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const entries = await ws.tree();
      if (stopped) return;
      const next = new Set(entries.map((e) => e.path));
      if (prev !== null) {
        for (const p of next) {
          if (!prev.has(p)) onChanged(p);
        }
        for (const p of prev) {
          if (!next.has(p)) onChanged(p);
        }
      }
      prev = next;
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const id = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

function resolveObserverCtor(
  observer: FileSystemObserverCtor | null | undefined,
): FileSystemObserverCtor | null {
  // Explicit null forces poll (tests).
  if (observer === null) return null;

  if (typeof observer === "function") {
    return observer;
  }

  const g = globalThis as unknown as { FileSystemObserver?: FileSystemObserverCtor };
  if (typeof g.FileSystemObserver === "function") {
    return g.FileSystemObserver;
  }
  return null;
}

export function startWatch(
  ws: { tree(): Promise<Array<{ path: string }>> },
  onChanged: (path: string) => void,
  opts?: {
    intervalMs?: number;
    now?: () => number;
    /** Injected constructor, or `null` to force poll. Defaults to `globalThis.FileSystemObserver`. */
    observer?: FileSystemObserverCtor | null;
    /** Root handle for `observe`. Without it, falls back to poll even if a constructor exists. */
    root?: unknown;
  },
): Watcher {
  const intervalMs = opts?.intervalMs ?? 3000;
  const Ctor = resolveObserverCtor(
    opts && "observer" in opts ? opts.observer : undefined,
  );
  const root = opts?.root;

  // Only use the observer path when we can actually call observe(root).
  // A present-but-unwired FileSystemObserver must not disable watching.
  if (Ctor && root != null) {
    const watched = tryStartObserver(Ctor, onChanged, root);
    if (watched) return watched;
  }

  return startPoll(ws, onChanged, intervalMs);
}
