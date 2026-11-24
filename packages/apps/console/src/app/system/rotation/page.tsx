"use client";
// 0.5.1 B5-10 /system/rotation · Bento P5 看板（2026-11-15）
// 数据：GET /api/rotation（status 运行态/定时/累计 + timeline 轮转记录 1207 行）。
// 口径：0.5.1 只读 —— 原页启停/立即执行/保存配置（POST /api/rotation）写控件不渲染；
//       累计处理记录=status.totalRecords（接口汇总字段）；时间线仅展示最近记录，二者不混。
import { useState, useEffect } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, Pager, States, Toolbar, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface Status {
  enabled?: boolean; status?: string; cronExpression?: string; cronHumanReadable?: string;
  maxPerRun?: number; projectFilter?: string | null; lastRunAt?: string | null; lastError?: string | null;
  totalRuns?: number; totalRecords?: number; nextRunAt?: string | null; isCurrentlyRunning?: boolean;
}
interface TL { date: string; recordsSynced: number; status: string; duration?: number; sourceType: string }
interface Resp { ok?: boolean; status?: Status | null; timeline?: TL[] | null; error?: string | null }

const PAGE_SIZE = 20;

export default function RotationPage() {
  const res = useResource<Resp>("/api/rotation", { pollMs: 60000 });
  const [reqAt, setReqAt] = useState<string | null>(null);
  useEffect(() => { setReqAt(new Date().toISOString()); }, []);
  const forced = usePhaseOverride();
  const base = forced && forced !== "ok" ? forced : res.phase;
  const phase = base === "ok" && !res.data?.status && !res.data?.timeline?.length ? "empty" : base;
  const st = res.data?.status ?? null;
  const tl = res.data?.timeline ?? [];
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(tl.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);

  const k = (v: number | null | undefined, hint: string, tone?: "info" | "ok" | "warn" | "crit"): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint, tone: tone || "info" };
  const running = st?.isCurrentlyRunning === true || st?.status === "RUNNING";

  const cols: DataColumn<TL>[] = [
    { key: "time", title: "时间", width: 180, render: (x) => <span className={kit.mono}>{x.date ? fmtTime(x.date) : "n/a"}</span> },
    { key: "source", title: "来源", width: 200, render: (x) => <span className={kit.mono}>{x.sourceType || "n/a"}</span> },
    { key: "status", title: "状态", width: 100, render: (x) => <Tone tone={x.status === "COMPLETED" ? "ok" : x.status === "FAILED" ? "crit" : "warn"}>{x.status === "COMPLETED" ? "完成" : x.status === "FAILED" ? "失败" : x.status || "n/a"}</Tone> },
    { key: "records", title: "处理记录", align: "right", width: 110, render: (x) => <span className={kit.num}>{fmtNum(x.recordsSynced)}</span> },
  ];

  return (
    <main className="page">
      <h1 className={kit.srOnly}>飞轮自动轮转</h1>
      <PageHeader>
        <PageTitle>飞轮自动轮转</PageTitle>
        <div className="page-subtitle">定时把会话轮转成认知资产 · 0.5.1 只读（不渲染启停/立即执行等写控件）· 数据时刻 {reqAt ? fmtTime(reqAt) : "n/a"}（请求时刻）</div>
        <Chips group="系统" page="轮转" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/rotation" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无轮转任务" emptyDetail="轮转接口正常返回但没有状态与时间线（空集，不是不可得）。"
        unavailableTitle="轮转数据不可得" unavailableDetail="rotation 未返回 status/timeline；补齐路径：BFF 输出 status 与 timeline。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="运行状态" metric={st ? { kind: "value", value: running ? (st.status === "RUNNING" ? "运行中" : "执行中") : (st.status === "STOPPED" ? "已停止" : (st.status || "n/a")), hint: "status=" + (st.status || "n/a") + " · enabled=" + String(st.enabled), tone: running ? "ok" : "warn" } : { kind: "na", reason: "status 未下发" }} />
          <KpiTile span={3} label="定时" metric={st?.cronHumanReadable ? { kind: "value", value: st.cronHumanReadable, hint: st.cronExpression || "", } : { kind: "na", reason: "cron 未下发" }} />
          <KpiTile span={3} label="总运行次数" metric={k(st?.totalRuns, "status.totalRuns（接口汇总）")} />
          <KpiTile span={3} label="累计处理记录" metric={k(st?.totalRecords, "status.totalRecords（接口汇总，非时间线求和）")} />

          <BentoCard span={8} title="最近轮转记录" sub={"时间线共 " + fmtNum(tl.length) + " 行 · 每页 " + PAGE_SIZE + " 条（接口最多返回 1207 行）"}>
            <Toolbar right="只读 · GET /api/rotation" />
            <DataTable<TL> columns={cols} rows={tl.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE)} rowKey={(_x, i) => cur * PAGE_SIZE + i}
              empty={{ title: "无轮转记录", desc: "时间线为空（空集，不是不可得）。" }} />
            <Pager page={cur} pages={pages} onPage={setPage} totalText={"共 " + fmtNum(tl.length) + " 条 · 第 " + (cur + 1) + " / " + pages + " 页" + (cur === pages - 1 ? " · 已到最后一页" : "")} />
          </BentoCard>

          <BentoCard span={4} title="轮转摘要" sub="运行态与配置（只读）">
            <ul className={kit.kv}>
              <li><span>上次运行</span><b>{st?.lastRunAt ? fmtTime(st.lastRunAt) : "n/a（无记录）"}</b></li>
              <li><span>下次运行</span><b>{st?.nextRunAt ? fmtTime(st.nextRunAt) : "n/a（未启用/未排期）"}</b></li>
              <li><span>单次上限</span><b>{st?.maxPerRun != null ? fmtNum(st.maxPerRun) + " 条" : "n/a"}</b></li>
              <li><span>项目过滤</span><b>{st?.projectFilter || "全部"}</b></li>
              <li><span>当前执行中</span><b>{st?.isCurrentlyRunning == null ? "n/a" : st.isCurrentlyRunning ? "是" : "否"}</b></li>
              <li><span>最后错误</span><b>{st?.lastError ? String(st.lastError).slice(0, 60) : "无（null）"}</b></li>
            </ul>
            <Note>累计处理记录取接口 status.totalRecords；时间线行数 {fmtNum(tl.length)} 是接口返回窗口，不用来重算累计。</Note>
          </BentoCard>

          <BentoCard span={12} title="只读说明与口径">
            <ul className={kit.kv}>
              <li><span>写操作</span><b>0.5.1 只读：启动/停止/立即执行/保存配置（POST /api/rotation）不渲染，待写通路契约开放。</b></li>
              <li><span>累计口径</span><b>总运行次数与累计处理记录来自 status 汇总字段；不与时间线行数混用。</b></li>
              <li><span>下次运行</span><b>nextRunAt=null 表示未启用（enabled=false）或未排期 → 显示 n/a 并注明，不写日期。</b></li>
            </ul>
            <Note>相关视图：<a className={kit.link} href="/system/access-log">访问日志</a> · <a className={kit.link} href="/flywheel/tasks">改进任务</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}