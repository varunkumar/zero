import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

export function Editor(props: { content: string; onSave: (text: string) => void }) {
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
        ],
      }),
    });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content]);

  return <div ref={host} style={{ height: "100%" }} />;
}
