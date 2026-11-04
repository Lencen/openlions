"use client";
import BarChart from "@/components/BarChart";
import { Panel, SimpleTable, Note, Pill } from "./ui";
import { ProductionFunnel, ConsumptionFunnel } from "./Funnels";
import { OutputTrend, FlowTrend } from "./TrendChart";
import { ACTIONS, ci, cp, ct, ch, ctime } from "./caliber";

function D1({ s }: { s: any }) {
  const a = (s.business && s.business.assets) || {};
  const t = a.totals || {};
  const c = a.connections || {};
  const tiers = Object.entries(a.tiers || {});
  return (
    <>
      <div className="card-grid cols-2">
        <Panel title="资产总量与结构" extra="当前存量（未撤回、非 stale）">
          <SimpleTable
            head={["资产", "存量", "口径"]}
            rows={[
              ["记忆", ci(t.Memory), "未撤回"],
              ["知识", ci(t.Knowledge), "未撤回且非 stale"],
              ["实践", ci(t.Practice), "未撤回且非 stale"],
              ["技能", ci(t.Skill), "未撤回且非 stale"],
              ["主题反思", ci(t.FlywheelReflection), "新表；状态 OK/FAILED"],
              ["历史反思", ci(t.Reflection), "旧表；状态 ACTIVE/OPEN"],
            ]}
          />
          <Note tone="warn">与调研稿 16:10 的数字不可直接比：资产表被清理过（记忆 107,105 → 63,882，知识 90,483 → 53,086 等）。看板只认当前快照。</Note>
        </Panel>
        <Panel title="连接密度" extra="有连接的实践 / 全部实践">
          <BarChart bars={[
            { label: "实践→记忆 " + cp(c.memory && c.memory.pct), value: Number(c.memory && c.memory.pct) || 0, color: "var(--table-memory)" },
            { label: "实践→知识 " + cp(c.knowledge && c.knowledge.pct), value: Number(c.knowledge && c.knowledge.pct) || 0, color: "var(--table-knowledge)" },
            { label: "实践→技能 " + cp(c.skill && c.skill.pct), value: Number(c.skill && c.skill.pct) || 0, color: "var(--table-skill)" },
            { label: "实践→产出 " + cp(c.output && c.output.pct), value: Number(c.output && c.output.pct) || 0, color: "var(--table-practice)" },
          ]} />
          <Note tone="warn">连接稀 = 经验没有挂到它用过的认知上。实践→产出 {cp(c.output && c.output.pct)}，但 →记忆只有 {cp(c.memory && c.memory.pct)}、→知识 {cp(c.knowledge && c.knowledge.pct)}。</Note>
        </Panel>
      </div>
      <div className="card-grid cols-2">
        <Panel title="反思双表" extra="权威表未定，不合并">
          <SimpleTable
            head={["表", "存量", "状态分布", "本页用法"]}
            rows={[
              ["主题反思", ci(a.reflection && a.reflection.topic), Object.entries(a.reflection && a.reflection.topicStatus || {}).map(([k, v]) => k + " " + ci(v)).join(" / "), "跨会话主题聚合，近 24 小时仍在写"],
              ["历史反思", ci(a.reflection && a.reflection.legacy), Object.entries(a.reflection && a.reflection.legacyStatus || {}).map(([k, v]) => k + " " + ci(v)).join(" / "), "旧反思，保留展示，不合并"],
            ]}
          />
          <Note tone="warn">两张表都在写。“合计一个反思总量”会制造第二个口径；本页并列展示，等权威表拍板。</Note>
        </Panel>
        <Panel title="温度分层与清理后状态" extra="记忆温度 / 技能遗留 / 知识 stale">
          <SimpleTable
            head={["项", "值", "含义"]}
            rows={[
              ...tiers.map(([k, v]) => ["记忆 · " + k, ci(v), "记忆温度分层"]),
              ["技能遗留占比", cp(a.skillLegacy && a.skillLegacy.pct), "遗留 " + ci(a.skillLegacy && a.skillLegacy.legacy) + " / " + ci(a.skillLegacy && a.skillLegacy.total)],
              ["知识 stale 标记", ci(a.knowledgeStale), "被标记为过期/不可用；不等于已删除"],
            ]}
          />
          <Note>技能遗留清理后只剩 23 条（0.12%），已不是主要问题；知识 stale 仍有 32,017 条，需要单独治理。</Note>
        </Panel>
      </div>
    </>
  );
}

function D2({ s }: { s: any }) {
  const hist = (s.business && s.business.history) || {};
  const series = hist.series || [];
  return (
    <>
      <Panel title="产出与结构化（14 天）" extra="UTC 自然日 · R3 阴影区">
        {series.length ? <div style={{ minHeight: 280 }}><OutputTrend series={series} /></div> : <Note>无 14 天序列。</Note>}
      </Panel>
      <Panel title="认领与交付（14 天）" extra="智能体交付为虚线">
        {series.length ? <div style={{ minHeight: 280 }}><FlowTrend series={series} /></div> : <Note>无 14 天序列。</Note>}
      </Panel>
      <Panel title="逐日明细" extra="阶段由 UTC 日期切分；跨阶段不可直接比">
        <SimpleTable
          head={["日期", "阶段", "新任务", "认领", "完成", "智能体交付", "结构化", "产出合计"]}
          rows={series.slice().reverse().map((x: any) => [
            x.date,
            <Pill key={x.date} status={x.regime === "R3" ? "crit" : "info"}>{x.regime}</Pill>,
            ci(x.newTasks), ci(x.claims), ci(x.done), ci(x.agentDone), ci(x.structured),
            ci(Object.values(x.output || {}).reduce((a: number, v: any) => a + (Number(v) || 0), 0)),
          ])}
        />
        <Note tone="warn">14 天窗口从 {hist.from ? hist.from.slice(0, 10) : "—"} 到 {hist.to ? hist.to.slice(0, 10) : "—"}，跨了 R2 与 R3。R2 的智能体转化 5–17%，R3 当前 0%；把两段混成一条“长期 0–4%”会掩盖 10-22 的突变。</Note>
      </Panel>
      <Panel title="零事件与停摆" extra="监控必须能识别“全链路停 2 天”">
        <SimpleTable head={["项", "值", "说明"]} rows={[
          ["零事件天数", ci((hist.zeroEventDays || []).length), (hist.zeroEventDays || []).join(" / ") || "本窗口没有"],
          ["当前阶段", (s.business && s.business.regime && s.business.regime.current) || "—", (s.business && s.business.regime && s.business.regime.label) || "—"],
          ["14 天可比", s.business && s.business.regime && s.business.regime.comparable ? "是" : "否", s.business && s.business.regime && s.business.regime.note || ""],
        ]} />
      </Panel>
    </>
  );
}

function D3({ s }: { s: any }) {
  const b = (s.business) || {};
  const h = b.health || {};
  const noData = b.noData || [];
  const proxy = [
    ["完成", "状态被改成完成", "定时任务自动关单占 75%+", "拆智能体/定时任务 + 配验收"],
    ["记使用", "提交成功时把本次注入全部记一次", "不是阅读/引用", "看实时引用 + 读报告人数"],
    ["评分", "写入时的自评/模型分", "跨来源口径不同（0.40–0.95）", "分来源展示 + 抽样复核"],
    ["在用智能体", "心跳最后在线", "心跳不等于在工作", "加“近 1 小时有交付/认领”"],
    ["队列净增", "新增 − 完成", "进水口枯竭时会假性稳定", "加任务生成/结构化领先指标"],
  ];
  return (
    <>
      <div className="card-grid cols-2">
        <Panel title="数据健康分构成" extra="建议分；按违规率扣分，有红线封顶 60">
          <SimpleTable head={["维度", "权重", "违规率", "状态", "明细", "复算"]}
            rows={(h.items || []).map((it: any) => [
              it.label, String(it.weight), cp((Number(it.rate) || 0) * 100, 0),
              <Pill key={it.key} status={it.status as any} />,
              <span key={"d" + it.key} className="tiny">{it.detail}</span>,
              <code key={"v" + it.key}>{it.verify}</code>,
            ])} />
          <Note tone="warn">红线：{(h.redlines || []).join("；") || "无"}。它衡量“数字能不能信”，不是业务 KPI。</Note>
        </Panel>
        <Panel title="无数据 / 不完整项" extra="无数据 ≠ 达标；不完整 ≠ 0">
          <SimpleTable head={["项目", "原因", "复算"]}
            rows={noData.map((x: any) => [x.label, x.reason, <code key={x.key}>{x.verify}</code>])}
            empty="本次没有无数据项" />
        </Panel>
      </div>
      <Panel title="口径警示：权威口径与业务扩展的差异" extra="页面必须按“用哪一列”读">
        <SimpleTable head={["字段", "问题", "本页改用", "复算"]}
          rows={(b.canonicalWarnings || []).map((w: any) => [<code key="f">{w.field}</code>, w.issue, w.use, <code key="v">{w.verify}</code>])}
          empty="无" />
      </Panel>
      <Panel title="代理指标风险" extra="每个数字都在测某个东西，但不一定测的是名字">
        <SimpleTable head={["指标", "它其实在测什么", "风险", "建议"]} rows={proxy} />
      </Panel>
    </>
  );
}

function D4({ s }: { s: any }) {
  const b = s.business || {};
  const q = b.queue || {};
  const causes = s.causes || {};
  const d = s.delivery || {};
  const reasonRows = (causes.topReasons || []).map((r: any) => [<span key="r" className="tiny">{r.reason}</span>, ci(r.n)]);
  return (
    <>
      <div className="card-grid cols-2">
        <ProductionFunnel s={s} />
        <ConsumptionFunnel s={s} />
      </div>
      <div className="card-grid cols-2">
        <Panel title="队列解剖" extra="大存量没人碰 + 小热集高重复认领">
          <SimpleTable head={["指标", "值", "含义"]} rows={[
            ["待认领存量", ci(s.queue && s.queue.PENDING), "当前状态"],
            ["3 天以上占比", cp(q.age3dPct), "存量在老化"],
            ["从未认领占比", cp(q.neverClaimedPct), "不是“被反复领走又放回”"],
            ["首次认领等待 P50", ch(q.firstClaimWait && q.firstClaimWait.p50Hours), "样本 " + ci(q.firstClaimWait && q.firstClaimWait.sample)],
            ["首次认领等待 P90", ch(q.firstClaimWait && q.firstClaimWait.p90Hours), "长尾更严重"],
            ["重复认领倍数", s.flow && s.flow.churn != null ? Number(s.flow.churn).toFixed(2) + " 倍" : "不可测", "认领 / 去重任务"],
            ["隔离存量", ci(s.queue && s.queue.BLOCKED), "领了不做 / 租约到期"],
          ]} />
        </Panel>
        <Panel title="放回结构" extra="两个分母分开说">
          <BarChart bars={[
            { label: "租约到期", value: Number(causes.counts && causes.counts.leaseTtl) || 0, color: "var(--status-warn)" },
            { label: "外部故障", value: Number(causes.counts && causes.counts.externalFault) || 0, color: "var(--status-crit)" },
            { label: "其他", value: Number(causes.counts && causes.counts.other) || 0, color: "var(--text-muted)" },
            { label: "大脑通道", value: Number(causes.counts && causes.counts.brain) || 0, color: "var(--info)" },
          ]} />
          <SimpleTable head={["口径", "值", "说明"]} rows={[
            ["全部放回 · 通道类", cp(causes.releaseShare && causes.releaseShare.channelPct), "排障口径：衡量交付通道浪费"],
            ["隔离 · 通道类", cp(causes.blocked && causes.blocked.channelPct), "验收入口：verdict 只认这个"],
            ["外部故障构成", Object.entries(causes.externalBreakdown || {}).map(([k, v]) => k + " " + ci(v)).join(" / "), "细分类"],
          ]} />
          <Note tone="warn">同一个数被读成 0% 或 48% 的原因就是分母不同；页面必须同时标口径。</Note>
        </Panel>
      </div>
      <div className="card-grid cols-2">
        <Panel title="交付通道与闸门" extra="24 小时事件计数">
          <SimpleTable head={["项", "次数"]} rows={[
            ["外部故障", ci(d.submitExternalFaults)],
            ["认领被拒", ci(d.claimsRejected)],
            ["证据驳回", ci(d.evidenceRejected)],
            ["无改动声明", ci(d.noChangeDeclared)],
            ["窗口内无提交", ci(d.noCommitInWindow)],
            ["健康闸门跳过", ci(d.claimSkipped)],
            ["任务复活", ci(d.taskRevived)],
          ]} />
        </Panel>
        <Panel title="放回原因 Top 10" extra="原文；不参与占比">
          <SimpleTable head={["原因", "次数"]} rows={reasonRows} />
        </Panel>
      </div>
    </>
  );
}

function D5({ s }: { s: any }) {
  const b = s.business || {};
  const cost = b.cost || {};
  const llm = cost.llm || {};
  const g = cost.gateway || {};
  const rows = (llm.bySource || []).map((r: any) => [
    r.src, ci(r.calls), ci(r.ok), ci(r.empty), cp(r.emptyPct), cp(r.rateLimitPct),
  ]);
  return (
    <>
      <Panel title="词元三层：通道 / 平台 / 归因" extra="三层不可相加">
        <SimpleTable head={["层", "量", "调用/事件", "口径", "用法"]} rows={[
          ["网关通道级", ct(g.tokens), ci(g.calls), "网关侧精确总量（OpenClaw / Hermes）", "成本总量以此为准"],
          ["平台内部", ct(cost.platform && cost.platform.tokens), "—", "平台内部模型调用（成功调用的精确值）", "单列，不与网关相加"],
          ["逐智能体归因", "覆盖 " + cp(cost.agent && cost.agent.coveragePct), ci(cost.agent && cost.agent.events), "逐调用上报且带词元的事件", "只做归因参考；上游常不返回用量"],
        ]} />
        <Note tone="warn">总词元只取网关（没有网关才退平台）；逐智能体归因不参与总量。当前覆盖率 {cp(cost.agent && cost.agent.coveragePct)}，低于 95%，页面显式标“归因不完整”。</Note>
      </Panel>
      <div className="card-grid cols-2">
        <Panel title="按来源的调用质量" extra="24 小时">
          <SimpleTable head={["来源", "调用", "成功", "空输出", "空输出率", "限流率"]} rows={rows} />
        </Panel>
        <Panel title="单位经济" extra="交付为 0 时不硬算">
          <SimpleTable head={["项", "值", "说明"]} rows={[
            ["总调用", ci(llm.total), "含平台内部 + 智能体上报"],
            ["成功率", cp(llm.okPct), "成功 / 全部"],
            ["空输出率", cp(llm.emptyPct), "目标 ≤25%"],
            ["限流率", cp(llm.rateLimitPct), "目标 ≤10%"],
            ["智能体交付", ci(b.delivery && b.delivery.agentDone), "本窗口为 0"],
            ["每交付调用", b.delivery && b.delivery.agentDone ? ci((Number(llm.total) || 0) / Number(b.delivery.agentDone)) + " 次/条" : "无数据（交付为 0）", "不拿 0 做分母"],
            ["单价 / 金额", cost.unitPriceCny == null ? "未配置" : cost.unitPriceCny + " 元/千词元", "金额只能按月合同分摊，不出精确金额"],
          ]} />
        </Panel>
      </div>
      <Panel title="空输出率（按智能体）" extra="执行质量差异，不是模型总量问题">
        <BarChart bars={(b.org && b.org.emptyOutputByAgent || []).map((r: any) => ({
          label: (r.agentId || r.agent) + " " + cp(r.emptyPct) + "（" + ci(r.calls) + " 次）",
          value: Math.round(Number(r.emptyPct) || 0),
          color: (Number(r.emptyPct) || 0) >= 50 ? "var(--status-crit)" : (Number(r.emptyPct) || 0) >= 25 ? "var(--status-warn)" : "var(--status-ok)",
        }))} />
        <Note>空输出是确定的浪费；分智能体差异远大于任务难度差异。公平性需按任务类型×描述体量分层后再下结论。</Note>
      </Panel>
    </>
  );
}

function D6({ s }: { s: any }) {
  const b = s.business || {};
  const au = b.audit || {};
  const ac = b.acceptance || {};
  const classes = au.classes || {};
  const byAction = au.byAction || [];
  const triage = ((byAction.find((x: any) => x.action === "TRIAGE_STALE") || {}).n) || 0;
  const sourceRows = [
    ["正式验收", ac.runner && ac.runner.pass, ac.runner && ac.runner.fail, ac.runner && ac.runner.total, ac.runner && ac.runner.lastAt, "有否决权"],
    ["影子验收", ac.shadow && ac.shadow.pass, ac.shadow && ac.shadow.fail, ac.shadow && ac.shadow.total, ac.shadow && ac.shadow.lastAt, "诊断；不改任务状态"],
    ["历史回填", ac.backfill && ac.backfill.pass, ac.backfill && ac.backfill.fail, ac.backfill && ac.backfill.total, ac.backfill && ac.backfill.lastAt, "历史账本；不代表窗口"],
  ];
  return (
    <>
      <Panel title="验收按来源拆分" extra="不要把影子验收混进正式通过率">
        <SimpleTable head={["来源", "通过", "失败", "合计", "最后判定", "用途"]}
          rows={sourceRows.map((r: any) => [r[0], ci(r[1]), ci(r[2]), ci(r[3]), ctime(r[4]), r[5]])} />
        <Note tone="warn">窗口内正式验收 {ci(ac.runner && ac.runner.pass)} 通过 / {ci(ac.runner && ac.runner.fail)} 失败；影子验收 {ci(ac.shadow && ac.shadow.pass)} 通过 / {ci(ac.shadow && ac.shadow.fail)} 失败（人工 20/20 一致）。7 天覆盖按任务去重，与“24 小时判定条数”不是同一分母。影子失败都是零有效动作，应回执行体复盘，不能直接当业务失败。</Note>
      </Panel>
      <div className="card-grid cols-2">
        <Panel title="审计五类覆盖" extra="Asia/Shanghai 本地墙钟">
          <SimpleTable head={["类", "条数", "说明"]} rows={[
            ["资产", ci(classes.asset), "策略变更/撤回/合并/清理"],
            ["访问", ci(classes.access), "管理员读取/授权/换钥"],
            ["决策", ci(classes.decision), "人类决策落地"],
            ["任务", ci(classes.task), "已满足下线 / 批量清理"],
            ["系统", ci(classes.system), "无步骤技能清理等"],
            ["其他", ci(classes.other), "未归类"],
          ]} />
          <Note>窗口内 {ci(au.events)} 条、高危 {ci(au.highRisk)} 条；最后 {ctime(au.lastAt)}。审计时间不迁移到世界时，展示显式标本地。{triage ? " 任务类里 " + ci(triage) + " 条是批量清理（TRIAGE_STALE），不是一次人工下线动作；五类真实 E2E 见下方动作明细。" : ""}</Note>
        </Panel>
        <Panel title="风险存量" extra="看得见存量，也要看得见结果">
          <SimpleTable head={["风险", "当前", "说明"]} rows={[
            ["正式验收覆盖（7 天）", cp(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.runnerPct), "完成 " + ci(b.delivery && b.delivery.acceptanceCoverage && b.delivery.acceptanceCoverage.done)],
            ["定时任务关单比", cp(b.delivery && b.delivery.cronDonePct), "自动关单不等于交付"],
            ["隔离存量", ci(s.queue && s.queue.BLOCKED), "24 小时新增 " + ci(s.causes && s.causes.blocked && s.causes.blocked.total)],
            ["人类决策积压", ci(s.closedLoop && s.closedLoop.humanDecision && s.closedLoop.humanDecision.doing), "进行中；p50 " + ch(s.closedLoop && s.closedLoop.humanDecision && s.closedLoop.humanDecision.p50Hours)],
            ["测试污染", ci(Object.values((s.hygiene && s.hygiene.testPollution) || {}).reduce((a: number, v: any) => a + (Number(v) || 0), 0)), "生产资产表里的自测行"],
          ]} />
        </Panel>
      </div>
      <Panel title="审计动作明细" extra="窗口内；按动作聚合">
        <SimpleTable head={["动作", "类", "次数", "最后（本地）"]}
          rows={byAction.map((r: any) => [<code key="a">{r.action}</code>, r.cls, ci(r.n), ctime(r.last)])} />
      </Panel>
    </>
  );
}

function D7({ s }: { s: any }) {
  const b = s.business || {};
  const org = b.org || {};
  const claims = org.claimsByAgent || [];
  const empty = org.emptyOutputByAgent || [];
  const agents = org.activeAgents || [];
  return (
    <>
      <div className="card-grid cols-2">
        <Panel title="认领分布（24 小时）" extra="按执行者">
          <SimpleTable head={["智能体", "认领"]} rows={claims.map((r: any) => [r.agentId || r.agent, ci(r.n)])} />
        </Panel>
        <Panel title="空输出率（按智能体）" extra="执行质量差异">
          <BarChart bars={empty.map((r: any) => ({
            label: (r.agentId || r.agent) + " " + cp(r.emptyPct),
            value: Math.round(Number(r.emptyPct) || 0),
            color: (Number(r.emptyPct) || 0) >= 50 ? "var(--status-crit)" : (Number(r.emptyPct) || 0) >= 25 ? "var(--status-warn)" : "var(--status-ok)",
          }))} />
          <SimpleTable head={["智能体", "调用", "空输出", "空输出率", "限流"]}
            rows={empty.map((r: any) => [r.agentId || r.agent, ci(r.calls), ci(r.empty), cp(r.emptyPct), ci(r.rateLimit)])} />
        </Panel>
      </div>
      <Panel title="智能体注册与心跳" extra="注册状态=心跳，不等于在工作">
        <SimpleTable head={["智能体", "注册状态", "最后心跳"]}
          rows={agents.map((r: any) => [r.name || r.id, r.status, ctime(r.lastSeenAt)])} />
        <Note tone="warn">本窗口智能体交付为 0，但多个智能体心跳正常：心跳与产出不是一回事。孤儿回收 {ci(org.orphanRecoveries)} 次 / 24 小时，是重复认领的头号人为原因。</Note>
      </Panel>
      <Panel title="交付与公平性" extra="先分层，再比较">
        <SimpleTable head={["项", "值", "说明"]} rows={[
          ["智能体交付", ci(b.delivery && b.delivery.agentDone), "完成者为智能体的记录"],
          ["定时任务关单", ci(b.delivery && b.delivery.cronDone), "自动关单"],
          ["健康闸门跳过", ci(org.claimSkipped), "被闸门拦下的认领"],
          ["孤儿回收", ci(org.orphanRecoveries), "任务复活代理指标"],
          ["跨智能体公平性", "需分层后才能判", "按任务类型×描述体量分层；本页不直接下“谁不行”的结论"],
        ]} />
      </Panel>
    </>
  );
}

function D8({ s }: { s: any }) {
  const rows = ACTIONS.map((a) => ({
    ...a,
    st: a.status(s),
    cur: a.current(s),
  })).sort((x, y) => {
    const rank: any = { crit: 0, warn: 1, nodata: 2, info: 3, ok: 4 };
    return (rank[x.st] ?? 9) - (rank[y.st] ?? 9);
  });
  return (
    <>
      <Panel title="动作表（指标 → 责任人 → 阈值 → 动作 → 复算）" extra="红在前；每条都可复算">
        <SimpleTable
          head={["状态", "指标", "当前", "阈值", "责任人", "第一动作", "复算"]}
          rows={rows.map((a) => [
            <Pill key={a.key} status={a.st} />,
            a.metric,
            a.cur,
            a.threshold,
            a.owner,
            <span key={"act" + a.key} className="tiny">{a.action}{a.note ? <span style={{ color: "var(--text-muted)" }}>（{a.note}）</span> : null}</span>,
            <code key={"v" + a.key}>{a.verify}</code>,
          ])}
        />
      </Panel>
      <Panel title="怎么用这张表" extra="不是报表，是一条流水线">
        <Note>先看红色：验收覆盖 → 智能体交付/转化 → 重复认领 → 队列老化 → 通道/空输出。每次只改一个因子，改完用同一行复算命令复核；不要用“总量没变”判断动作有效。</Note>
      </Panel>
    </>
  );
}

export default function DimensionBody({ id, s }: { id: string; s: any }) {
  if (id === "d1") return <D1 s={s} />;
  if (id === "d2") return <D2 s={s} />;
  if (id === "d3") return <D3 s={s} />;
  if (id === "d4") return <D4 s={s} />;
  if (id === "d5") return <D5 s={s} />;
  if (id === "d6") return <D6 s={s} />;
  if (id === "d7") return <D7 s={s} />;
  return <D8 s={s} />;
}
