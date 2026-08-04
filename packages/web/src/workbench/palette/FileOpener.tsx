import { Palette } from "./Palette";

export function FileOpener(props: { paths: string[]; open: boolean; onClose: () => void; onOpen: (path: string) => void }) {
  return (
    <Palette
      open={props.open}
      onClose={props.onClose}
      items={props.paths}
      getLabel={(p) => p}
      onSelect={props.onOpen}
      placeholder="Go to file…"
    />
  );
}
