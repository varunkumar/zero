import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { ghostText } from "./ghostText";

export function Editor(props: {
  path: string | null;
  content: string;
  onSave: (text: string) => void;
  onChange?: (text: string) => void;
  requestCompletion?: (s: { prefix: string; suffix: string }) => void;
  onViewChange?: (view: EditorView | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  // Path the currently-live EditorView was created for. Extensions below
  // read callbacks off this ref rather than closing over `props` directly,
  // since the view (and its extensions) can now outlive a single render.
  const propsRef = useRef(props);
  propsRef.current = props;
  const loadedPathRef = useRef<string | null>(null);

  // Create the view once per file. Switching files (path changes) is a full
  // rebuild, which is correct: cursor/selection/undo history from file A
  // shouldn't leak into file B. Content changes for the SAME file (e.g. a
  // reconciled external edit) must NOT land here — see the effect below.
  useEffect(() => {
    view.current?.destroy();
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: propsRef.current.content,
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => { propsRef.current.onSave(v.state.doc.toString()); return true; },
            },
          ]),
          ghostText((s) => propsRef.current.requestCompletion?.(s)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) propsRef.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    loadedPathRef.current = props.path;
    propsRef.current.onViewChange?.(view.current);
    return () => {
      view.current?.destroy();
      view.current = undefined;
      propsRef.current.onViewChange?.(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // Content changed while the SAME file stays open (e.g. a reconciled
  // external change to the file on disk). Dispatch a document-replace
  // transaction into the existing view instead of destroying/recreating it,
  // so cursor position, selection, and undo history survive. The mount
  // effect above already handles the initial doc for a newly opened file,
  // so skip this when path just changed too (loadedPathRef !== props.path
  // means the mount effect hasn't caught up yet in this same render pass,
  // or is about to run).
  useEffect(() => {
    if (!view.current) return;
    if (loadedPathRef.current !== props.path) return;
    const current = view.current.state.doc.toString();
    if (current === props.content) return;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: props.content },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content]);

  return <div ref={host} style={{ height: "100%" }} />;
}
