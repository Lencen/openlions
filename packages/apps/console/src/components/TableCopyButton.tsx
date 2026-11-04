"use client";
// 2026-10-15（round 76-ET，数据展示规范 §2「每张表提供复制/导出」）
//   —— 一处实现、全站复用：组件只吃一个指向 <table> 的 ref，直接**从 DOM 读表**，
//      页面侧不需要把行列数据再传一遍（控制台 87 张表，逐个 plumb 数据不现实）。
//   复制格式用 TSV（制表符分隔）—— 粘进 Excel / 表格软件天然分列。
import { useEffect, useRef, useState } from "react";
import { Button, ReloadOutlined } from "@/components/primitives";

/** 把 DOM 里的 table 读成 TSV 文本（表头 + 数据行；跳过空行）。 */
export function tableToTsv(table: HTMLTableElement | null): string {
  if (!table) return "";
  const rows: string[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.querySelectorAll("th,td"));
    if (cells.length === 0) continue;
    const line = cells
      .map((c) => String((c as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
      .join("\t");
    if (line.replace(/\t/g, "").trim() === "") continue; // 空行不复制
    rows.push(line);
  }
  return rows.join("\n");
}

export default function TableCopyButton({
  target,
  label = "复制表格",
  exportedName,
}: {
  /** 指向要复制的 <table>。**不传**则自动定位最近的 <table>（见下表说明）。 */
  target?: React.RefObject<HTMLTableElement | null>;
  label?: string;
  /** 给了名字就顺带提供「导出 CSV」（下载文件）。 */
  exportedName?: string;
}) {
  // 2026-10-15（round 76-EU）：新增**自动定位**模式 —— 不传 target 时，挂载后从自身往上找最近的
  //   <table>。这样每张表只需在原位插一行 <TableCopyButtonAuto/>（**不用加 ref、不用改成客户端组件**，
  //   因此服务端组件也能用）。仍然是**普通 React 子节点**，不是往别人的树里注入 DOM。
  const selfRef = useRef<HTMLSpanElement | null>(null);
  const [autoTarget, setAutoTarget] = useState<HTMLTableElement | null>(null);
  useEffect(() => {
    if (target) return;
    const self = selfRef.current;
    if (!self) return;
    // 2026-10-15（round 76-EV）**修一个实测出来的选错表 bug**：
    //   原实现先走 `parentElement.querySelector("table")` —— 它返回的是**容器里的第一张表**,
    //   于是"一个容器里有两张表"时, 第二个按钮也会复制第一张表 ✗（在 /system/health 实测复现）。
    //   现在按**文档顺序**取"该按钮**之后的最近一张表**", 单表/多表都对。
    const after = Array.from(document.querySelectorAll("table")).filter(
      (t) => self.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (after.length) setAutoTarget(after[0] as HTMLTableElement);
  }, [target]);
  const resolved = target ? target.current : autoTarget;
  const [tip, setTip] = useState<string>("");
  const flash = (m: string) => { setTip(m); window.setTimeout(() => setTip(""), 1600); };

  const doCopy = async () => {
    const tsv = tableToTsv(resolved);
    if (!tsv) { flash("没有可复制的内容"); return; }
    try {
      await navigator.clipboard.writeText(tsv);
      flash("已复制 " + (tsv.split("\n").length - 1) + " 行");
    } catch {
      flash("复制失败（浏览器未授权剪贴板）");
    }
  };

  const doExport = () => {
    const tsv = tableToTsv(resolved);
    if (!tsv || !exportedName) return;
    const csv = tsv.split("\n").map((l) => l.split("\t").map((c) => '"' + c.replace(/"/g, '""') + '"').join(",")).join("\n");
    // BOM 让 Excel 正确识别 UTF-8
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportedName.endsWith(".csv") ? exportedName : exportedName + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
    flash("已导出 CSV");
  };

  return (
    <span ref={selfRef} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <Button size="small" onClick={doCopy}>{label}</Button>
      {exportedName ? <Button size="small" icon={<ReloadOutlined />} onClick={doExport}>导出 CSV</Button> : null}
      {tip ? <span className="tiny" style={{ color: "var(--status-ok)" }}>{tip}</span> : null}
    </span>
  );
}
