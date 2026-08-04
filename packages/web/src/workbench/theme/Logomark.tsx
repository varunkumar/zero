export function Logomark(props: { theme: "light" | "dark"; size?: number }) {
  const size = props.size ?? 20;
  return (
    <img
      src={`/zero-mark-${props.theme}.png`}
      alt="Zero"
      width={size}
      height={size}
      style={{ borderRadius: "50%", display: "block" }}
    />
  );
}
