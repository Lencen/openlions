// 2026-10-20 R8：统一的"加载中"骨架屏。
// 现状：全站 9 处加载态各写各的（多为一行"加载中…"），既没有形状也没有占位感，
//   切换时会跳版。这里用一个共用组件给出稳定占位（默认 3 行，行高可调）。
// 2026-11-05 P2：行高/行宽的内联样式改为 data-h / data-last 档位类（见 LoadingBlock.module.css）。
import styles from "./LoadingBlock.module.css";

export default function LoadingBlock({ lines = 3, height = 14, label }: { lines?: number; height?: number; label?: string }) {
  return (
    <div className="lb-wrap" role="status" aria-live="polite" aria-label={label || "加载中"}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={"lb-line " + styles.line}
          data-h={height}
          data-last={i === lines - 1 ? "1" : undefined}
        />
      ))}
    </div>
  );
}
