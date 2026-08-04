import type { ReactNode } from "react";
import "./theme.css";

export function ThemeProvider(props: { theme: "light" | "dark"; children: ReactNode }) {
  return (
    <div data-theme={props.theme} style={{ height: "100%" }}>
      {props.children}
    </div>
  );
}
