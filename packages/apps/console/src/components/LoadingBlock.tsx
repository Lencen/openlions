// 2026-10-20 R8：统一的"加载中"骨架屏。
// 现状：全站 9 处加载态各写各的（多为一行"加载中…"），既没有形状也没有占位感，
//   切换时会跳版。这里用一个共用组件给出稳定占位（默认 3 行，行高可调）。
export default function LoadingBlock({ lines = 3, height = 14, label }: { lines?: number; height?: number; label?: string }) {
  return (
    <div className="lb-wrap" role="status" aria-live="polite" aria-label={label || "加载中"}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="lb-line" style={{ height, width: i === lines - 1 ? "62%" : "100%" }} />
      ))}
    </div>
  );
}
