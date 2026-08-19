import { useEffect, useRef } from "react";

/** Mounts an imperative `mount(el) -> cleanup` contribution (a plugin's
 * status bar item or sidebar panel) into a host-managed div. Every plugin
 * contribution uses this same shape, so this is the one place that owns
 * the mount-on-effect / cleanup-on-unmount wiring. A throwing mount or
 * cleanup is caught and logged rather than propagating - a broken plugin
 * contribution must degrade to "nothing rendered here", never take down
 * the rest of the workbench. */
export function PluginSlot(props: { mount: (el: HTMLElement) => () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cleanup: (() => void) | undefined;
    try {
      cleanup = props.mount(el);
    } catch (e) {
      console.error("plugin contribution failed to mount:", e);
      return;
    }
    return () => {
      try {
        cleanup?.();
      } catch (e) {
        console.error("plugin contribution failed to clean up:", e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mount]);
  return <div ref={ref} style={{ display: "contents" }} />;
}
