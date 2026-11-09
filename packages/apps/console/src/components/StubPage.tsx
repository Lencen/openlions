"use client";
// 2026-11-09 · 0.4.39-05/07：目标 IA 里 4 个"新建"页的共用骨架（商业线裁决：按 /tools 骨架四态标准）。
//   口径：数据接口尚未接入的页面，**只做结构与四态**，并在页面上写明"数据未接入 + 补齐路径"——
//   不写 0（0 会被当成实测值），不伪造数据。
//   四态来源：对一个既有只读端点做可用性探测（401/403 -> 无权限；其它失败 -> 错误；200 -> 结构 + 空态）。
//   探测结果不参与任何指标计算，页面里也不出现业务数据。
import { useCallback, useEffect, useState } from "react";
import { ErrorBlock, PageHeader, PageTitle, Pill, StateBlock } from "@/components/ui";

type Phase = "loading" | "ok" | "error" | "forbidden";

export default function StubPage(props: {
  title: string;
  desc: string;
  probe: string;        // 只读探测端点（既有 API）
  todo: string;         // "为什么还没有数据 + 从哪里补"
  extra?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [probeMsg, setProbeMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setProbeMsg(null);
    (async () => {
      try {
        const r = await fetch(props.probe, { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setProbeMsg("探测 " + props.probe + " 返回 " + r.status); setPhase("error"); return; }
        setPhase("ok");
      } catch {
        if (!alive) return;
        setProbeMsg("探测 " + props.probe + " 请求失败");
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [props.probe, nonce]);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>{props.title}</PageTitle>
        <Pill tone="neutral">结构稿</Pill>
      </PageHeader>
      <p className="tiny">{props.desc}</p>

      {phase === "loading" ? (
        <StateBlock title="加载中" desc="正在检查数据接口可用性…" />
      ) : phase === "forbidden" ? (
        <StateBlock
          title="无权限"
          desc="当前账号没有查看本页的权限（探测返回 401/403）。请用有权限的账号登录，或联系平台管理员开通。"
        />
      ) : phase === "error" ? (
        <ErrorBlock message={probeMsg || "数据接口不可用"} onRetry={reload} />
      ) : (
        <>
          <StateBlock
            title="数据未接入"
            desc={props.todo}
            action={<button className="btn" onClick={reload}>重新检查</button>}
          />
          {props.extra}
        </>
      )}
    </main>
  );
}
