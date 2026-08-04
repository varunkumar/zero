import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { ghostText } from "./ghostText";

export function Editor(props: {
  content: string;
  onSave: (text: string) => void;
  onChange?: (text: string) => void;
  requestCompletion?: (s: { prefix: string; suffix: string }) => void;
  onViewChange?: (view: EditorView | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();

  useEffect(() => {
    view.current?.destroy();
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.content,
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => { props.onSave(v.state.doc.toString()); return true; },
            },
          ]),
          ghostText((s) => props.requestCompletion?.(s)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) props.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    props.onViewChange?.(view.current);
    return () => {
      view.current?.destroy();
      props.onViewChange?.(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content]);

  return <div ref={host} style={{ height: "100%" }} />;
}
