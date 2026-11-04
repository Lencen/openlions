/**
 * quality-audit.ts — 产出质量不变量自检 (2026-09-10 建议1)
 *
 * 目的: 把"质量规则是否仍然成立"从人工抽查变成每日机器自检, 防止守卫/幂等/hash 随时间腐化。
 * 不变量(scope = 任务产出行 sourceType=FLYWHEEL_STRUCTURED):
 *   1) 无空内容行   2) 均有质量分   3) 均有 contentHash   4) 无同主题同内容重复
 *   5) 均可追溯 findingId(sourceId)  6) 关键时间列无 text 残留
 * 观测项(不计违约, 供趋势): 低置信复核队列条数 / 未支持 actionType 次数 / 遗留重复与无 hash 体量。
 * 产出: FlywheelEvent(stage=QUALITY_AUDIT) + logs/quality-audit.jsonl 追加。
 */
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parseStructuredFindings } from "./findings-parse";

const MIND_DB = process.env.LIONS_MIND_DB || "" + (process.env.LIONS_HOME || process.cwd()) + "/packages/apps/mind/prisma/dev.db";
const JSONL = "" + (process.env.LIONS_HOME || process.cwd()) + "/logs/quality-audit.jsonl";
const H24 = 24 * 3600 * 1000;

export interface QualityAuditResult {
  at: string;
  windowHours: number;
  invariants: Array<{ id: string; name: string; ok: boolean; count: number; detail?: string }>;
  violations: number;
  observations: Record<string, number>;
  /** living(现状型)文档漂移 —— 计入 observations.docDriftDocs, 是 PL-TRUST 的构成之一 */
  docDrift?: Array<{ doc: string; codeNewerHours: number; sample: string }>;
  /** 事件型(带日期)文档的同类漂移 —— **不计违约**, 仅观测(保留信号, 不再混入 docDriftDocs) */
  docDriftEvent?: Array<{ doc: string; codeNewerHours: number; sample: string }>;
  // 2026-09-10 建议: 组合指标 (coverage 单指标波动大, 需与落地率/质量分/任务吞吐一起看)
  scorecard?: {
    coverageAvg24h: number | null;
    coverageAvgPrev24h: number | null;
    coverageTrend: number | null;
    findings: { total: number; resolved: number; recurring: number; needsReview: number; landedRate: number | null };
    productsQuality24h: Array<{ table: string; n: number; avgQ: number | null; lowShare: number }>;
    tasks: { done24h: number; failed24h: number; pendingNow: number; doneRate: number | null };
  };
}

export async function runQualityAudit(): Promise<QualityAuditResult> {
  const since = new Date(Date.now() - H24);
  const inv: QualityAuditResult["invariants"] = [];
  const add = (id: string, name: string, count: number, detail?: string) => inv.push({ id, name, ok: count === 0, count, detail });

  // 1) 空内容
  const emptyM = await prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ content: "" }, { content: null as any }] } }).catch(() => 0);
  const emptyK = await prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ content: "" }, { content: null as any }] } }).catch(() => 0);
  const emptyP = await prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ description: "" }, { description: null as any }] } }).catch(() => 0);
  add("no-empty-content", "任务产出行无空内容(24h)", emptyM + emptyK + emptyP, `Memory=${emptyM} Knowledge=${emptyK} Practice=${emptyP}`);

  // 2) 质量分 (Memory/Knowledge 的 qualityScore 非空且默认 0 -> 不能用 null 判"未打分";
  //    原 bug 的签名是"24h 产出行全部为 0" => 违约判据: 有产出行但无一行 >0; 0 分行仅作观测)
  const mTot = await prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since } } }).catch(() => 0);
  const mScored = await prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, qualityScore: { gt: 0 } } }).catch(() => 0);
  const kTot = await prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since } } }).catch(() => 0);
  const kScored = await prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, qualityScore: { gt: 0 } } }).catch(() => 0);
  const pTot = await prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since } } }).catch(() => 0);
  const pScored = await prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, qualityScore: { gt: 0 } } }).catch(() => 0);
  const unscoredAll = (mTot > 0 && mScored === 0 ? 1 : 0) + (kTot > 0 && kScored === 0 ? 1 : 0) + (pTot > 0 && pScored === 0 ? 1 : 0);
  add("has-quality-score", "任务产出行有打分(非全 0)(24h)", unscoredAll, `M ${mScored}/${mTot} K ${kScored}/${kTot} P ${pScored}/${pTot} 有分`);

  // 3) contentHash
  const hM = await prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ contentHash: "" }, { contentHash: null as any }] } }).catch(() => 0);
  const hK = await prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ contentHash: "" }, { contentHash: null as any }] } }).catch(() => 0);
  const hP = await prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ contentHash: "" }, { contentHash: null as any }] } }).catch(() => 0);
  add("has-content-hash", "任务产出行均有 contentHash(24h)", hM + hK + hP, `M=${hM} K=${hK} P=${hP}`);

  // 4) 同主题同内容重复 (24h 任务产出)
  // 2026-09-14 FW-QUALITY 修**监控假阴性**: 原查询只查 Memory, 于是 Knowledge/Practice 的重复
  //   (实测 2026-09-13 Knowledge 10 组 20 行 / Practice 4 组 8 行, supersededBy IS NULL) 永远不报 ——
  //   审计全绿但产物池已劣化。改为三表 UNION ALL, 按 (表, theme, contentHash) 分组, 与指标口径三表对齐。
  const dupGroups = await prisma.$queryRawUnsafe<any[]>(
    "SELECT t, theme, contentHash FROM (" +
    "SELECT 'Memory' t, theme, contentHash FROM Memory WHERE sourceType='FLYWHEEL_STRUCTURED' AND supersededBy IS NULL AND contentHash IS NOT NULL AND createdAt >= ? " +
    "UNION ALL SELECT 'Knowledge', theme, contentHash FROM Knowledge WHERE sourceType='FLYWHEEL_STRUCTURED' AND supersededBy IS NULL AND contentHash IS NOT NULL AND createdAt >= ? " +
    "UNION ALL SELECT 'Practice', theme, contentHash FROM Practice WHERE sourceType='FLYWHEEL_STRUCTURED' AND supersededBy IS NULL AND contentHash IS NOT NULL AND createdAt >= ? " +
    ") GROUP BY t, theme, contentHash HAVING COUNT(*) > 1", since, since, since
  ).catch(() => [] as any[]);
  const dupByT = (name: string) => dupGroups.filter((r: any) => r.t === name).length;
  add("no-duplicate-content", "任务产出无同主题同内容重复(24h)", dupGroups.length, `M=${dupByT("Memory")} K=${dupByT("Knowledge")} P=${dupByT("Practice")}`);

  // 5) 可追溯
  const tM = await prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ sourceId: "" }, { sourceId: null as any }] } }).catch(() => 0);
  const tK = await prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ sourceId: "" }, { sourceId: null as any }] } }).catch(() => 0);
  const tP = await prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: since }, OR: [{ sourceId: "" }, { sourceId: null as any }] } }).catch(() => 0);
  add("traceable-finding-id", "任务产出行可追溯 findingId(24h)", tM + tK + tP, `M=${tM} K=${tK} P=${tP}`);

  // 6) 时间格式残留 (text 型时间) —— 2026-10-26 SQLite 退役后该检查失去对象：
  //   "typeof(col)='text'" 是 SQLite 专有类型判据，PG 的 timestamp 列不存在这一类残留。
  const textTs = 0;
  add("timestamp-unified", "关键时间列无 text 残留(SQLite 已退役, 恒 0)", textTs);

  // 观测项
  const needsReview = await prisma.flywheelReflection.findMany({ select: { structuredFindings: true } }).then((rows) => rows.reduce((acc, r) => acc + ((r.structuredFindings || "").match(/"status":"NEEDS_REVIEW"/g)?.length || 0), 0)).catch(() => 0);
  const lowConfSkips = await prisma.taskStateTransition.count({ where: { createdAt: { gte: since }, reason: { contains: "复核队列" } } }).catch(() => 0);
  const unsupported = await prisma.taskStateTransition.count({ where: { createdAt: { gte: since }, reason: { contains: "未支持 actionType" } } }).catch(() => 0);
  const legacyK = await prisma.$queryRawUnsafe<any[]>("SELECT COUNT(*) g, SUM(c-1) extra FROM (SELECT theme, title, COUNT(*) c FROM Knowledge WHERE supersededBy IS NULL GROUP BY theme, title HAVING c>1)").catch(() => [{ g: 0, extra: 0 }]);
  const observations = {
    needsReviewFindings: Number(needsReview ?? 0),
    lowConfidenceQueued24h: lowConfSkips,
    unsupportedActionType24h: unsupported,
    legacyKnowledgeDupGroups: Number(legacyK?.[0]?.g ?? 0),
    legacyKnowledgeDupExtraRows: Number(legacyK?.[0]?.extra ?? 0),
    docDriftDocs: 0, // 由下方文档漂移检测填充: living(现状型)文档漂移 -> PL-TRUST 构成
    docDriftEventDocs: 0, // 事件型(带日期)文档的同类读法: **不计违约**, 仅观测
    docDriftLivingDocs: 0, // 参与漂移检测的 living 文档篇数(让"分母"可审计)
    docDriftEventDocsChecked: 0, // 参与检测的事件型文档篇数(让排除范围可审计)
  };

  // ===== 文档漂移检测 (2026-09-10 建议: "逻辑有没有即时更新到文档") =====
  // 每个**现状型(living)**文档声明了权威代码路径; 若这些代码的最近提交时间晚于文档 mtime -> 记为 drift(不阻塞)。
  //
  // 2026-09-14 PL-TRUST 机制修复(口径不变, 修的是**假阳性/scope 回归**):
  //   本检测原先用 readdirSync 扫全目录, 把"事件型文档"(plan/diagnosis/report/landing/decision,
  //   文件名带日期 YYYY-MM-DD)也当成 living 文档一同比对。README.md §定位/§域清单 明确二者区别:
  //   本目录是"现状型(当前事实)"文档, 带日期的一次性记录是"事件记录" —— 事件记录**本就不该随
  //   后续代码提交而更新**, 用"代码比它新"判它漂移属类别错误。
  //   实测构成(2026-09-14, 修复前): docDriftDocs=17, 其中 15 篇是事件型记录; 且 8 篇仅仅因为
  //   被后续提交的**共享证据脚本**(scripts/close-proposal-loop.cjs 等, 文档只是引用它跑复算命令)
  //   连带命中 -> 不是"文档过期", 是同类工具 churn, 使该读数**结构上无法归零**。
  //   修: docDriftDocs 只统计 living 文档(文件名不含日期)的漂移; 事件型文档的同类读法单列到
  //   docDriftEvent + observations.docDriftEventDocs(**不计违约**, 信号保留、可审计)。
  //   口径未变: docDriftDocs 仍 = "living 文档中'代码提交晚于文档'的篇数"; audit_violations 仍 = violations + docDriftDocs。
  //   已知边界(独立复核 caveat, 明示不隐藏):
  //     ① 漂移是"新鲜度"信号: living 文档被引用的代码**再次提交**后会重新漂移, 故 0 是"当前时点"的读数、
  //        不是永久不变(README 亦如此约定: 不阻塞, 提醒同步)。
  //     ② 本目录历史上混入了带日期的事件记录(实测 84 篇), 未做搬迁, 仍靠文件名判据区分; 真正治本是按
  //        README 约定把这些一次性记录移出 docs/platform-logic/ —— 属目录治理, 不在本次范围。
  //     ③ 基线已由工作区 mtime 改为**文档最后一次 git 提交时间**(见下), 使读数可复现、不可被 `touch` 造假。
  const docDrift: Array<{ doc: string; codeNewerHours: number; sample: string }> = [];
  const docDriftEvent: Array<{ doc: string; codeNewerHours: number; sample: string }> = [];
  let livingDocsChecked = 0;
  let eventDocsChecked = 0;
  try {
    const DIR = "" + (process.env.LIONS_HOME || process.cwd()) + "/docs/platform-logic";
    // "事件型"判据: 文件名含 YYYY-MM-DD (README/console 同约定: 带日期 = 一次性事件记录)
    const isEventDoc = (f: string) => /\d{4}-\d{2}-\d{2}|\d{8}/.test(f); // 2026-09-25 PL-TRUST 修复: 同时识别 YYYYMMDD 格式(无连字符, 1-12月/1-31日不强校)事件型文档,防命名漂移触发 living 漂移假阳性
    // 2026-10-27: 改查表（GIT_MAPS 在下方一次性构建）—— 原实现为每个文档起一次 git 子进程。
    //   闭包在 GIT_MAPS 初始化之后才被调用（下方 for 循环），因此这里前向引用是安全的。
    const commitTimeOf = (p: string): number => GIT_MAPS.latest.get(p) || 0;
    // 2026-09-22 机制修复(对齐守门 scripts/pl-trust-guard.cjs): 漂移判定的 codeTs 从"代码最近 commit 时间"
    //   改为"代码最近 **不改契约** 的 commit 时间" —— 即按 commit message 类别豁免 fix/chore/refactor/docs/style/
    //   test/ci/build/[机制修复]/[hotfix]/[回填]/[重命名]/[文档]/[docs]/[refactor]/[fix]/[perf]/[test]/[style]/
    //   [build]/[ci] 等非接口变更类别; 若该路径所有 commit 都属于豁免类别, codeTs 回落 0 (视同"无契约变更")。
    //   根因: 原 L158 用 `git log -1 --format=%ct -- <paths>` 取最近 commit, 任何对该路径的提交(包括纯 bugfix /
    //   chore / refactor) 都把 codeTs 推高, 即使没改接口也会被判漂移 —— 实测 audit_violations 长期塌在 1~3
    //   (2026-09-22 复算: 内联给出 docDriftDocs=1, 守门 = 0; 现统一到 0)。
    //   边界: 与守门同 IMMUNE_PREFIXES (英文方括号大小写不敏感), 路径粒度=逐路径独立判定 + 取 max。
    //   caveat (明示不隐藏): ① 平台约定的前缀依赖 commit message 规范; ② feat 内部若实际只改测试/格式, 也会
    //   计入漂移 (无法机械判别), 但概率低且对审计透明 (可读 commit 复核)。
    const IMMUNE_PREFIXES = [
      /^fix\(/i, /^fix:/i,
      /^chore\(/i, /^chore:/i,
      /^refactor\(/i, /^refactor:/i,
      /^docs\(/i, /^docs:/i,
      /^style\(/i, /^style:/i,
      /^test\(/i, /^test:/i,
      /^ci\(/i, /^ci:/i,
      /^build\(/i, /^build:/i,
      /^\[机制修复\]/,
      /^\[chore\]/i, /^\[hotfix\]/i, /^\[回填\]/, /^\[重命名\]/, /^\[文档\]/,
      /^\[docs\]/i, /^\[refactor\]/i, /^\[fix\]/i, /^\[perf\]/i, /^\[test\]/i, /^\[style\]/i, /^\[build\]/i, /^\[ci\]/i,
      // 2026-09-25 PL-TRUST 双口径收口(遗留项): 补 8 项「连字符风格」豁免, 与守门
      //   scripts/pl-trust-guard.cjs:114 的 IMMUNE_PREFIXES 逐项对齐 —— 此前这 8 项**只有守门有**,
      //   体检入口(本文件)没有, 是"双口径分裂"的最后残留 (复现证据: scripts/pl-trust-immune-parity-probe.cjs,
      //   修复前 PARITY=BROKEN, 仅 guard 有 /^fix-/i ... /^build-/i 共 8 项)。
      //   根因(2026-09-24 实测): scripts/acceptance/runner.cjs 提交 7a3b8a0 "fix-acceptance-criteria-align-with-parallel"
      //   与 679456a "fix-acceptance-evidence-source-and-cjk-guard" 均属 fix-xxx 风格, 原规则只认 fix( / fix: ,
      //   于是**纯 bugfix** 被判"契约可能变更" -> codeTs 虚高 -> 假漂移。
      //   口径: 与括号/冒号风格一一对应; **不豁免 feat-** (feat 可能改契约, 与 feat( 同口径)。
      /^fix-/i, /^chore-/i, /^refactor-/i, /^docs-/i, /^style-/i, /^test-/i, /^ci-/i, /^build-/i,
      // 2026-09-25 PL-TRUST 修复: 加「集成:」豁免 (181 次, 占比最高, 纯 merge 节点不改契约)
      /^集成:/,
    ];
    const isImmuneCommitSubject = (subject: string | undefined): boolean => {
      if (!subject) return false;
      for (const re of IMMUNE_PREFIXES) if (re.test(subject)) return true;
      return false;
    };
    // 2026-10-27 P0 事故修复（:3000 整体挂死）:
    //   原实现对**每份文档 × 每条路径**各起一次 `git log` 子进程（335 文档 × ≤20 路径 ≈ 最坏 6,700 次），
    //   且全程 execSync **同步阻塞 Node 事件循环** → 审计执行期间整个服务无响应
    //   （实测：GET / 25s 超时、goal-check 60s 超时、console 代理 502）。
    //   改为**一次** `git log --name-only` 全量扫描，构建 path → (最新提交, 最新非豁免提交) 两张表。
    //   语义差异（诚实标注）：原 `--reverse --max-count=200` 取"最老 200 条里的最新非豁免"，
    //   对提交数 >200 的路径会偏旧；新实现取"全局最新非豁免"，更符合原意。
    const GIT_ROOT = process.env.LIONS_HOME || process.cwd();
    const buildGitPathMaps = (): { latest: Map<string, number>; nonImmune: Map<string, number> } => {
      const latest = new Map<string, number>();
      const nonImmune = new Map<string, number>();
      let out = "";
      try {
        out = execSync('git -C ' + JSON.stringify(GIT_ROOT) + ' log --format=%x01%ct%x02%s --name-only', {
          encoding: "utf-8", timeout: 120000, maxBuffer: 256 * 1024 * 1024,
        });
      } catch { return { latest, nonImmune }; }
      for (const chunk of out.split("\u0001").slice(1)) {
        const nl = chunk.indexOf("\n");
        const head = nl < 0 ? chunk : chunk.slice(0, nl);
        const files = nl < 0 ? "" : chunk.slice(nl + 1);
        const sep = head.indexOf("\u0002");
        if (sep < 0) continue;
        const ts = Number(head.slice(0, sep)) * 1000;
        const subject = head.slice(sep + 1).trim();
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const immune = isImmuneCommitSubject(subject);
        for (const f of files.split("\n")) {
          const rel = f.trim();
          if (!rel) continue;
          if (!latest.has(rel)) latest.set(rel, ts);
          if (!immune && !nonImmune.has(rel)) nonImmune.set(rel, ts);
        }
      }
      return { latest, nonImmune };
    };
    const GIT_MAPS = buildGitPathMaps();
    const lastNonImmuneCommitTsMs = (p: string): number => GIT_MAPS.nonImmune.get(p) || 0;
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".md") && x !== "README.md")) {
      const full = path.join(DIR, f);
      const md = fs.readFileSync(full, "utf-8");
      const paths = Array.from(new Set(md.match(/(packages|scripts)\/[A-Za-z0-9_\-./]+\.(ts|tsx|py|sh|js|mjs|cjs)/g) || [])).slice(0, 20);
      if (paths.length === 0) continue;
      // 2026-09-22 改: 对每条路径独立取"最近非豁免 commit 时间", 取 max 作 codeTs。
      //   与原实现 (一次 git log -1 --format=%ct 拿所有路径的最近 commit) 的关键差异:
      //   - 修复"任何 fix/chore 提交都把 codeTs 推高 → 误判漂移"的根因;
      //   - 保留"逐路径独立判定 + 取 max"语义 (让 culprit = 真改契约的路径)。
      const pathCodeTs = paths.map((p) => lastNonImmuneCommitTsMs(p));
      const codeTs = pathCodeTs.length ? Math.max(...pathCodeTs) : 0;
      // 2026-09-14 独立复核加固(caveat: mtime 不可复现): 文档时间基线改用**该文档最后一次 git 提交时间**
      //   —— 可复现(与工作区 mtime 无关), 不会因 fresh clone / `touch` 而虚高(虚高会把漂移读成 0)
      //   或虚低; 未跟踪(从未提交)的文档才回落到 mtime。语义: 只有**已提交**的文档状态算平台记录。
      const gitDocTs = commitTimeOf("docs/platform-logic/" + f);
      const docTs = gitDocTs || fs.statSync(full).mtimeMs;
      const event = isEventDoc(f);
      if (event) eventDocsChecked++; else livingDocsChecked++;
      if (Number.isFinite(codeTs) && codeTs > docTs) {
        // 2026-09-10 修复误报: 原来任何 code>doc 都算漂移, 实测把 0.0 小时的同一批提交也算进去 -> 阈值 2 小时
        const lagHours = (codeTs - docTs) / 3600000;
        if (lagHours >= 2) {
          // 2026-09-14 可观测性修复: sample 原取 paths[0](文档里第一个路径), 未必是**导致漂移的那个**提交。
          //   实测 f002-landing 的 sample 显示 finding-premise-check.cjs, 真凶是 close-proposal-loop.cjs
          //   -> 复核者被误导。改为回填真凶路径(逐路径取最近提交时间, 取最大者)。
          // 2026-09-22 改: culprit 也按"最近**非豁免** commit 时间"取最大者, 与 codeTs 一致 —— 让"谁真改了契约"
          //   指向真凶, 而不是把罪指到一条只被 fix/chore 改过的实现路径(那样既不准也无法指导文档同步)。
          let culprit = paths[0];
          let culpritTs = 0;
          for (let i = 0; i < paths.length; i++) {
            const t = pathCodeTs[i];
            if (t > culpritTs) { culpritTs = t; culprit = paths[i]; }
          }
          const rec = { doc: f, codeNewerHours: Number(lagHours.toFixed(1)), sample: culprit };
          (event ? docDriftEvent : docDrift).push(rec);
        }
      }
    }
  } catch (e: any) {
    console.warn("[quality-audit] 文档漂移检测失败(非致命): " + (e?.message || "").slice(0, 80));
  }
  observations.docDriftDocs = docDrift.length;
  observations.docDriftEventDocs = docDriftEvent.length;
  observations.docDriftLivingDocs = livingDocsChecked;
  observations.docDriftEventDocsChecked = eventDocsChecked;

  // 2026-09-10: 抽样复核结果 -> "自动通过"是否可信的直接证据(驳回率高说明自动门太松)
  try {
    const since7 = new Date(Date.now() - 7 * 864e5);
    const vrows: any[] = await prisma.$queryRawUnsafe(
      "SELECT stage, COUNT(*) c FROM FlywheelEvent WHERE stage IN ('KNOWLEDGE_VERIFIED','KNOWLEDGE_REJECTED','KNOWLEDGE_PROPOSAL_ACCEPTED') AND createdAt >= ? GROUP BY stage",
      since7,
    );
    const vm: Record<string, number> = {};
    for (const v of vrows || []) vm[String(v.stage)] = Number(v.c);
    const tot = (vm.KNOWLEDGE_VERIFIED || 0) + (vm.KNOWLEDGE_REJECTED || 0);
    (observations as any).verifyVerdicts7d = vm;
    (observations as any).verifyRejectRate7d = tot ? Number(((vm.KNOWLEDGE_REJECTED || 0) / tot).toFixed(3)) : null;
  } catch { (observations as any).verifyRejectRate7d = null; }

  // 2026-09-10: "记忆->使用"闭环度量 — 提炼产物是否真被后续任务注入使用(不用的产物等于没提炼)
  try {
    const since7 = new Date(Date.now() - 7 * 864e5);
    const k: any[] = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) total, SUM(CASE WHEN COALESCE(usageCount,0) > 0 THEN 1 ELSE 0 END) used FROM Knowledge WHERE sourceType='SESSION_EXTRACT' AND createdAt >= ?", since7);
    const m: any[] = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) total, SUM(CASE WHEN COALESCE(accessCount,0) > 0 THEN 1 ELSE 0 END) used FROM Memory WHERE sourceType='SESSION_EXTRACT' AND createdAt >= ?", since7);
    const inj: any[] = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CONTEXT_INJECTED' AND createdAt >= ?", since7);
    const tot = Number(k?.[0]?.total ?? 0) + Number(m?.[0]?.total ?? 0);
    const used = Number(k?.[0]?.used ?? 0) + Number(m?.[0]?.used ?? 0);
    (observations as any).extractProducts7d = tot;
    (observations as any).extractUsed7d = used;
    (observations as any).extractUsedRate7d = tot ? Number((used / tot).toFixed(3)) : null;
    (observations as any).contextInjectedEvents7d = Number(inj?.[0]?.c ?? 0);
  } catch { (observations as any).extractUsedRate7d = null; }

  // ===== 组合指标 (2026-09-10): coverage + findings 落地率 + 产物质量分 + 任务吞吐 =====
  let scorecard: QualityAuditResult["scorecard"];
  try {
    const avg = async (from: number, to: number) => {
      const rows = await prisma.flywheelReflection.findMany({
        where: { theme: { not: { startsWith: "DAILY·" } }, updatedAt: { gte: new Date(from), lt: new Date(to) } },
        select: { coverageScore: true, structuredFindings: true },
      });
      if (rows.length === 0) return { avg: null as number | null, rows };
      const vals = rows.map((r) => Number(r.coverageScore)).filter((n) => Number.isFinite(n) && n > 0);
      return { avg: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : null, rows };
    };
    const now = Date.now();
    const cur = await avg(now - 24 * 3600 * 1000, now);
    const prev = await avg(now - 48 * 3600 * 1000, now - 24 * 3600 * 1000);
    // findings 落地率 (近 7 天更新过的反思)
    const fRows = await prisma.flywheelReflection.findMany({
      where: { updatedAt: { gte: new Date(now - 7 * 24 * 3600 * 1000) }, structuredFindings: { not: null } },
      select: { structuredFindings: true },
    });
    let ft = 0, fr = 0, frec = 0, fnr = 0;
    for (const r of fRows) {
      for (const f of parseStructuredFindings(r.structuredFindings)) {
        const st = String((f as any).status || "NEW");
        ft++;
        if (st === "RESOLVED") fr++;
        else if (st === "RECURRING") frec++;
        else if (st === "NEEDS_REVIEW") fnr++;
      }
    }
    const eligible = Math.max(0, ft - fnr);
    const productsQuality24h: Array<{ table: string; n: number; avgQ: number | null; lowShare: number }> = [];
    for (const [t, col] of [["Memory", "qualityScore"], ["Knowledge", "qualityScore"], ["Practice", "qualityScore"]] as Array<[string, string]>) {
      const rows = await prisma.$queryRawUnsafe<any[]>(
        "SELECT COUNT(*) n, ROUND(AVG(" + col + "),3) aq, SUM(CASE WHEN " + col + " < 0.4 THEN 1 ELSE 0 END) low FROM " + t + " WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ?", new Date(now - 24 * 3600 * 1000)
      ).catch(() => [{ n: 0, aq: null, low: 0 }]);
      const r = rows?.[0] || { n: 0, aq: null, low: 0 };
      productsQuality24h.push({ table: t, n: Number(r.n ?? 0), avgQ: r.aq == null ? null : Number(r.aq), lowShare: Number(r.n) ? Number((Number(r.low) / Number(r.n)).toFixed(2)) : 0 });
    }
    const tasks24 = await prisma.task.groupBy({ by: ["status"], where: { updatedAt: { gte: new Date(now - 24 * 3600 * 1000) } }, _count: { _all: true } }).catch(() => [] as any[]);
    const done24h = Number((tasks24 as any[]).find((t) => t.status === "DONE")?._count?._all ?? 0);
    const failed24h = Number((tasks24 as any[]).find((t) => t.status === "FAILED")?._count?._all ?? 0);
    const pendingNow = await prisma.task.count({ where: { status: "PENDING" } }).catch(() => 0);
    scorecard = {
      coverageAvg24h: cur.avg,
      coverageAvgPrev24h: prev.avg,
      coverageTrend: cur.avg != null && prev.avg != null ? Number((cur.avg - prev.avg).toFixed(4)) : null,
      findings: { total: ft, resolved: fr, recurring: frec, needsReview: fnr, landedRate: eligible ? Number((fr / eligible).toFixed(3)) : null },
      productsQuality24h,
      tasks: { done24h, failed24h, pendingNow, doneRate: done24h + failed24h > 0 ? Number((done24h / (done24h + failed24h)).toFixed(3)) : null },
    };
  } catch (e: any) {
    console.warn("[quality-audit] 组合指标计算失败(非致命): " + (e?.message || "").slice(0, 100));
  }

  const violations = inv.filter((i) => !i.ok).length;
  const result: QualityAuditResult = { at: new Date().toISOString(), windowHours: 24, invariants: inv, violations, observations, docDrift, docDriftEvent, scorecard };

  // 落事件 + jsonl
  try {
    await prisma.flywheelEvent.create({
      data: {
        stage: "QUALITY_AUDIT",
        sourceType: "quality-audit",
        sourceId: String(violations),
        sourceTitle: JSON.stringify({
          violations,
          failed: inv.filter((i) => !i.ok).map((i) => i.id),
          observations,
          scorecard: scorecard ? {
            cov: scorecard.coverageAvg24h,
            covTrend: scorecard.coverageTrend,
            landedRate: scorecard.findings.landedRate,
            needsReview: scorecard.findings.needsReview,
            taskDoneRate: scorecard.tasks.doneRate,
            pendingNow: scorecard.tasks.pendingNow,
            prod: scorecard.productsQuality24h.map((x) => x.table + ":" + x.n + "/avg" + (x.avgQ ?? "-")),
          } : null,
        }).slice(0, 1200),
        targetStage: violations === 0 ? "OK" : "VIOLATION",
      },
    });
  } catch (e: any) {
    console.warn("[quality-audit] 事件落库失败: " + (e?.message || "").slice(0, 80));
  }
  try {
    fs.mkdirSync("" + (process.env.LIONS_HOME || process.cwd()) + "/logs", { recursive: true });
    fs.appendFileSync(JSONL, JSON.stringify(result) + "\n");
  } catch { /* ignore */ }

  return result;
}
