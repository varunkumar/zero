import { expect, test } from "bun:test";
import { PtyStore } from "./store";

test("addSession makes it active; removeSession falls back to another session", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  expect(store.getActiveId()).toBe("a");
  store.addSession({ sessionId: "b", shell: "/bin/bash" });
  expect(store.getActiveId()).toBe("b");
  store.removeSession("b");
  expect(store.getActiveId()).toBe("a");
  expect(store.getSessions()).toEqual([{ sessionId: "a", shell: "/bin/bash" }]);
  store.removeSession("a");
  expect(store.getActiveId()).toBeNull();
});

test("onOutput only fires for its own sessionId", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  store.addSession({ sessionId: "b", shell: "/bin/bash" });
  const aChunks: string[] = [];
  const bChunks: string[] = [];
  store.onOutput("a", (d) => aChunks.push(d));
  store.onOutput("b", (d) => bChunks.push(d));
  store.handleOutput("a", "hello-a");
  store.handleOutput("b", "hello-b");
  expect(aChunks).toEqual(["hello-a"]);
  expect(bChunks).toEqual(["hello-b"]);
});

test("handleExit removes the session and notifies subscribers", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.handleExit("a");
  expect(store.hasSession("a")).toBe(false);
  expect(notified).toBe(1);
});

test("reattach (re-adding an already-known session) is idempotent and does not replay output", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });

  // Output produced before a listener subscribes (e.g. while the browser
  // tab was reloading) is not buffered - PtyStore has no replay log, so it
  // is simply gone, matching the "only new output after reattach" contract.
  store.handleOutput("a", "produced-before-reload");

  // Simulates reattach: the reload path calls addSession again for a
  // session that already exists (the daemon's pty/list still reports it).
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  expect(store.getSessions()).toEqual([{ sessionId: "a", shell: "/bin/bash" }]);

  const chunks: string[] = [];
  store.onOutput("a", (d) => chunks.push(d));
  store.handleOutput("a", "produced-after-reattach");

  expect(chunks).toEqual(["produced-after-reattach"]);
});

test("unsubscribed onOutput listener stops receiving data", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  const chunks: string[] = [];
  const unsubscribe = store.onOutput("a", (d) => chunks.push(d));
  store.handleOutput("a", "one");
  unsubscribe();
  store.handleOutput("a", "two");
  expect(chunks).toEqual(["one"]);
});
