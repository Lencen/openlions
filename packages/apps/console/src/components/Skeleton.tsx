interface Props {
  w?: number | string;
  h?: number | string;
  style?: React.CSSProperties;
}

export default function Skeleton({ w = "100%", h = 16, style }: Props) {
  return (
    <div
      className="skeleton"
      style={{ width: w, height: h, ...style }}
      aria-hidden="true"
    />
  );
}
