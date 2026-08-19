import { useEffect, useRef } from "react";

/** Mounts an imperative `mount(el) -> cleanup` contribution (a plugin's
 * status bar item or sidebar panel) into a host-managed div. Every plugin
 * contribution uses this same shape, so this is the one place that owns
 * the mount-on-effect / cleanup-on-unmount wiring. */
export function PluginSlot(props: { mount: (el: HTMLElement) => () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanup = props.mount(el);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mount]);
  return <div ref={ref} style={{ display: "contents" }} />;
}
