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

type FileSystemObserverCtor = new (
  callback: (records: ChangeRecord[]) => void,
) => FileSystemObserverLike;

function pathFromRecord(record: ChangeRecord): string | null {
  if (record.relativePathComponents && record.relativePathComponents.length > 0) {
    return record.relativePathComponents.join("/");
  }
  return record.changedHandle?.name ?? null;
}

function startObserver(
  Ctor: FileSystemObserverCtor,
  onChanged: (path: string) => void,
): Watcher {
  const obs = new Ctor((records) => {
    for (const record of records) {
      const path = pathFromRecord(record);
      if (path != null && path !== "") onChanged(path);
    }
  });
  return {
    stop() {
      try {
        obs.disconnect?.();
      } catch {
        // no-op-safe disconnect
      }
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
  observer: FileSystemObserverLike | null | undefined,
): FileSystemObserverCtor | null {
  // Explicit null forces poll (tests).
  if (observer === null) return null;

  if (typeof observer === "function") {
    return observer as unknown as FileSystemObserverCtor;
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
    observer?: FileSystemObserverLike | null;
  },
): Watcher {
  const Ctor = resolveObserverCtor(
    opts && "observer" in opts ? opts.observer : undefined,
  );
  if (Ctor) {
    return startObserver(Ctor, onChanged);
  }
  return startPoll(ws, onChanged, opts?.intervalMs ?? 3000);
}
