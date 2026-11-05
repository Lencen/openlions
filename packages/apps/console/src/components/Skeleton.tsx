// 2026-11-05 P2 批2：宽/高的内联样式下沉到 Skeleton.module.css。
//   尺寸走 data-w / data-h 档位（百分比与常用像素档），颜色/微光沿用 globals.css 的 .skeleton。
import styles from "./Skeleton.module.css";

interface Props {
  w?: number | string;
  h?: number | string;
  className?: string;
}

export default function Skeleton({ w = "100%", h = 16, className }: Props) {
  return (
    <div
      className={"skeleton " + styles.sk + (className ? " " + className : "")}
      data-w={String(w)}
      data-h={String(h)}
      aria-hidden="true"
    />
  );
}
