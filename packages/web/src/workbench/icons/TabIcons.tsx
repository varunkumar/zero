/** Small line icons for the sidebar/bottom-panel toggle tabs (Files, Search,
 * Terminal, Chat). Inline SVG rather than bundled assets - these are single-
 * color glyphs that need to track the button's current text color
 * (`currentColor`), including on hover/active, which a static image asset
 * can't do without per-theme file variants. Sized to sit inline with a
 * 14px label per the toggle buttons' existing font-size. */

const common = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function FilesTabIcon() {
  return (
    <svg {...common} aria-hidden>
      <path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5z" />
    </svg>
  );
}

export function SearchTabIcon() {
  return (
    <svg {...common} aria-hidden>
      <circle cx="6" cy="6" r="4" />
      <line x1="9" y1="9" x2="12.5" y2="12.5" />
    </svg>
  );
}

export function TerminalTabIcon() {
  return (
    <svg {...common} aria-hidden>
      <rect x="1" y="2" width="12" height="10" rx="1.2" />
      <path d="M3.5 5.2 5.8 7l-2.3 1.8" />
      <line x1="7" y1="9.3" x2="10" y2="9.3" />
    </svg>
  );
}

export function ChatTabIcon() {
  return (
    <svg {...common} aria-hidden>
      <path d="M1.5 3.2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H6.3l-2.9 2.2v-2.2h-.9a1 1 0 0 1-1-1V3.2z" />
    </svg>
  );
}

export function TasksTabIcon() {
  return (
    <svg {...common} aria-hidden>
      <rect x="1.5" y="1.5" width="4" height="4" rx="0.8" />
      <path d="M2.3 3.5 3.1 4.3 4.7 2.6" />
      <line x1="7.2" y1="3.5" x2="12.5" y2="3.5" />
      <rect x="1.5" y="8.5" width="4" height="4" rx="0.8" />
      <line x1="7.2" y1="10.5" x2="12.5" y2="10.5" />
    </svg>
  );
}
