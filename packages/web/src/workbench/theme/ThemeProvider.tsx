import { useEffect, type ReactNode } from "react";
import "./theme.css";

export function ThemeProvider(props: { theme: "light" | "dark"; children: ReactNode }) {
  // theme.css keys its custom properties off `:root[data-theme=...]`, so the
  // attribute has to land on <html>; the wrapper div below is under :root and
  // would never match. This provider is the single writer of that attribute.
  useEffect(() => {
    document.documentElement.dataset.theme = props.theme;
  }, [props.theme]);

  return (
    <div data-theme={props.theme} style={{ height: "100%" }}>
      {props.children}
    </div>
  );
}
