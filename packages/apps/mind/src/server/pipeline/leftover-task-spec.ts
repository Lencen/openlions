/**
 * 实践遗留 -> 改进任务的**任务规格**单一实现(2026-10-26 质量专项)。
 *
 * 为什么单独成模块:
 *   1) 生成端(session-extract)、存量重整(backfill 脚本)、单测必须用**同一套**判据,
 *      否则又会出"新单是 VERIFY、旧单还是 LANDING"的口径分叉;
 *   2) 下面这些判断都是纯函数(不碰 DB / 不起子进程), 可以离线复算:
 *        · 该遗留项到底要不要改代码(LANDING)还是只需取证结论(VERIFY);
 *        · 任务标题/描述/验收标准长什么样;
 *        · "什么算做完"与对应的验收命令。
 *
 * 背景(实测 2026-10-26): 1821 条 PENDING 全是 [落地] 实践遗留, 平均描述 920 字;
 *   其中大量单子其实只需"跑一遍/核一遍并给结论", 却按 LANDING 判 -> 没有改动声明 ->
 *   被 SUBMIT_CLAIMS_REJECTED 拒绝 -> 放回 -> 再领。本模块把"交付定义"写进任务本身:
 *   - 类型: [落地] 必须真改文件并提交; [验证] 只出结论但证据必须可复算;
 *   - 验收命令 / 期望输出 / 什么算做完(三件套)直接进描述, 执行体不用猜。
 *
 * 保守原则: 只有**明确出现"只查/只跑/只核"语义且没有任何改代码动词**时才判 VERIFY;
 *   其余一律 LANDING(保持现状), 避免用"类型二分"给假完成开口子。
 */
import {
  extractCommitRefs,
  extractRepoPathRefs,
  extractTaskRefCandidates,
  extractTodoRefs,
} from "./practice-leftover-staleness";

export type LeftoverTaskKind = "LANDING" | "VERIFY";

export interface LeftoverKindVerdict {
  kind: LeftoverTaskKind;
  /** 命中规则(进日志/单测, 便于解释为什么是这一类) */
  rule: "landing_verb" | "verify_verb" | "default_landing";
  /** 命中的动词(去重) */
  matched: string[];
}

/**
 * "必须改仓库文件"的动词。命中任一 -> LANDING, 无论是否同时出现核查类动词
 * (例: "核查并修复" 仍然是 LANDING)。
 *
 * 刻意**不收录**: 提交/发布/补写/更新/写入 —— 这些词在"提交报告""补写库内锚点"
 * 语境里并不要求 git 文件改动, 收进来会把该判 VERIFY 的单重新推回 LANDING。
 */
const LANDING_VERBS: readonly string[] = [
  "修复", "修好", "改正", "修改", "改成", "改为", "重构", "实现", "落地",
  "新增", "添加", "加入", "加上", "创建", "建立", "删除", "移除", "替换",
  "合并", "合入", "部署", "上线", "迁移", "接入", "升级", "降级", "拆分",
  "补齐", "补上", "补测试", "写测试", "改文档", "更新文档", "补文档", "改代码",
  // 2026-10-26 复查补: 英文/流水线词也是"必须真写文件"的强信号。
  //   实测误判: "[验证] 本轮未把复算结果写入新 verdict 并 safe-commit" —— 中文"提交"刻意不收
  //   (避免"提交报告"误判), 但 safe-commit/git commit/落盘 没有歧义。
  "safe-commit", "git commit", "commit 到", "提交代码", "写文件", "落盘",
];

/** "只需取证/给结论/交付报告"的动词。只在没有 LANDING 动词时生效。 */
const VERIFY_VERBS: readonly string[] = [
  "运行", "重跑", "重新运行", "复跑", "复算", "复测", "核查", "核对", "确认",
  "验证", "复核", "检查", "排查", "评估", "判断", "审计", "审查", "比对",
  "诊断", "定位", "取证", "给出结论", "给出判定", "报告", "汇报", "结项",
  "补写锚点", "回填锚点", "补证据", "补锚点",
];

function hits(text: string, words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) if (text.includes(w)) out.push(w);
  return out;
}

/**
 * 判一条遗留项的任务类型。纯函数, 无 IO。
 * 判定顺序: LANDING 动词优先 -> VERIFY 动词 -> 默认 LANDING(保守)。
 */
export function classifyLeftoverTaskKind(text: string): LeftoverKindVerdict {
  const t = String(text || "");
  const landing = hits(t, LANDING_VERBS);
  if (landing.length) return { kind: "LANDING", rule: "landing_verb", matched: landing };
  const verify = hits(t, VERIFY_VERBS);
  if (verify.length) return { kind: "VERIFY", rule: "verify_verb", matched: verify };
  return { kind: "LANDING", rule: "default_landing", matched: [] };
}

/**
 * 任务类别(2026-11-07 P0): 在 LANDING/VERIFY 之上再分"到底要做什么"。
 *   为什么必须分: 50 条抽样里只有 2% 真需要改代码; 14% 是集成者动作, 22% 是无改动/已闭环,
 *   22% 从未被领。只分 LANDING/VERIFY 会把"集成/文档/数据/验证"全塞进 LANDING, 继续制造无改动。
 */
export type LeftoverCategory = "CODE" | "DOC" | "INTEGRATION" | "VERIFY" | "DATA" | "HUMAN" | "CLOSED" | "GENERAL";

export interface LeftoverCategoryVerdict {
  category: LeftoverCategory;
  rule: string;
  matched: string[];
}

const CATEGORY_LABEL: Record<LeftoverCategory, string> = {
  CODE: "改代码(必须提交 + 复测)",
  DOC: "写文档/报告(必须落盘并提交)",
  INTEGRATION: "集成者动作(合并/cherry-pick, agent 不代做)",
  VERIFY: "核查验证(结论 + 证据锚点, 不要求改文件)",
  DATA: "改数据(库内前后证据, 不要求文件 commit)",
  HUMAN: "需人类决策(拍板/授权, agent 不代做)",
  CLOSED: "已闭环(不应再开单)",
  GENERAL: "一般任务(按交付定义)",
};

/** 集成者/人类动作: 命中即不应进 agent 队列。 */
const INTEGRATOR_RE = /集成者|cherry-pick|merge(?!-base)|合回\s*main|--merge|越权|合并冲突|冲突文件/i;
const HUMAN_RE = /拍板|决策|裁决|授权|需人类|人工确认|良晨|要人定/;
const CLOSED_RE = /按设计不动|无需重复|已由既有|已解决|已修复|已闭环|已处理|条件已消失/;
/** 全文还有"未完成"语义时, 不判 CLOSED(保守: 多段遗留不能被半句"已修复"吃掉)。 */
const CLOSED_NEGATIVE_RE = /未|尚未|仍需|但|待|不在\s*main/i;
const DATA_RE = /补写|回填|写入(?!侧)|落库|更新.{0,6}(状态|锚点|记录|数据)|SQL|数据库|改数据/;
const DOC_RE = /verdict|progress|文档|README|落盘|结项|写.{0,6}(报告|文档)|出.{0,4}报告|交.{0,4}报告/i;
const VERIFY_RE = /复算|复测|merge-base|grep|解析|打印|\bls\b|核查|确认|检查|比对|核对|运行|跑|验证|复核|调查|定位|诊断/i;
const CODE_RE = /修复|重试|实现|改|加|删|迁移|部署|重构|测试|补测试|写测试/;

/**
 * 判一条遗留项的类别。纯函数, 无 IO。
 * 顺序有意: 人类/集成 > 已闭环 > 数据 > 文档 > 验证 > 代码 > 一般。
 *   "已闭环"优先于"验证", 避免把"无需改动"再开成验证单; 但如果文本同时有"仍需/未做",
 *   由调用方/staleness 判, 本函数不替它做闭环决定。
 */
export function classifyLeftoverCategory(text: string): LeftoverCategoryVerdict {
  const t = String(text || "");
  const rules: Array<[LeftoverCategory, RegExp, string]> = [
    ["HUMAN", HUMAN_RE, "human_decision"],
    ["INTEGRATION", INTEGRATOR_RE, "integrator_action"],
    ["CLOSED", CLOSED_RE, "already_closed"],
    ["DATA", DATA_RE, "data_change"],
    ["DOC", DOC_RE, "doc_report"],
    ["VERIFY", VERIFY_RE, "verify_only"],
    ["CODE", CODE_RE, "code_change"],
  ];
  for (const [category, re, rule] of rules) {
    const m = t.match(re);
    if (m) {
      if (category === "CLOSED" && CLOSED_NEGATIVE_RE.test(t)) continue;
      return { category, rule, matched: [m[0]] };
    }
  }
  return { category: "GENERAL", rule: "default_general", matched: [] };
}

/** 类别 -> 任务类型(保证 kind 与类别不矛盾)。 */
export function kindForCategory(category: LeftoverCategory): LeftoverTaskKind {
  if (category === "VERIFY" || category === "DATA" || category === "CLOSED") return "VERIFY";
  return "LANDING";
}

export interface LeftoverTaskSpecInput {
  /** 遗留项原文 */
  text: string;
  /** 已判定的类型(调用方用 classifyLeftoverTaskKind 算, 避免本函数重复判) */
  kind: LeftoverTaskKind;
  /** 任务类别(不传则按文本自动判; 传了以传入为准) */
  category?: LeftoverCategory;
  practiceId: string;
  sessionUid: string;
  practiceTitle: string;
  practiceOutcome?: string | null;
  practiceContent: string;
  /** 需要人类拍板的遗留项: 保留 [需人类决策] 前缀, 认领端会拒收 */
  humanDecision?: boolean;
  /** 用于证据命令展示的仓库根(默认平台主库) */
  repoRoot?: string;
}

export interface LeftoverDeliverable {
  /** 验收命令(可照抄执行, 输出即证据) */
  commands: string[];
  /** 期望输出 */
  expected: string;
  /** 什么算做完 */
  done: string;
}

export interface LeftoverTaskSpec {
  kind: LeftoverTaskKind;
  category: LeftoverCategory;
  titlePrefix: string;
  title: string;
  description: string;
  requirements: string;
  acceptanceCriteria: string;
  deliverable: LeftoverDeliverable;
}

const DEFAULT_REPO = "~/lions";
const WORKTREE_ROOT = "~/lions-wt";

/**
 * 生成"工作落点"提示 —— 治"不敢改共享树"(实测产出原文: 需要另建独立 worktree, 当前尚未创建)。
 * VERIFY 与 LANDING 分开写: 只核查的单不该被"只改自己 worktree"误导成"要先建树才能读代码"。
 */
export function worktreeHint(repoRoot: string = DEFAULT_REPO, kind: LeftoverTaskKind = "LANDING"): string {
  if (kind === "VERIFY") {
    return (
      "【工作落点】只读核对可直接在主库 " + repoRoot + "; 需要写文件时必须用 " +
      WORKTREE_ROOT + "/<你的 agent-id>(分支 agent/<你的 agent-id>), 不存在先执行 bash " +
      repoRoot + "/scripts/agent-worktree.sh <你的 agent-id>; 不要修改主库。"
    );
  }
  return (
    "【工作落点】只改你自己的 worktree: " + WORKTREE_ROOT + "/<你的 agent-id>(分支 agent/<你的 agent-id>); " +
    "不存在就先在平台机执行 bash " + repoRoot + "/scripts/agent-worktree.sh <你的 agent-id>; " +
    "禁止改 " + repoRoot + " 主库(多人共享, 脏)。"
  );
}

/** 从遗留项文本里抽证据线索, 生成"照抄即可"的验收命令(按类别分模板)。 */
export function buildDeliverable(
  text: string,
  kind: LeftoverTaskKind,
  repoRoot: string = DEFAULT_REPO,
  category: LeftoverCategory = "GENERAL"
): LeftoverDeliverable {
  const cmds: string[] = [];
  const ids = [...extractTodoRefs(text), ...extractTaskRefCandidates(text)].slice(0, 2);
  const paths = extractRepoPathRefs(text).slice(0, 2);
  const shas = extractCommitRefs(text).slice(0, 2);

  if (category === "HUMAN" || category === "INTEGRATION") {
    return {
      commands: ["（需人类/集成者处理；agent 不要执行、不要代签）"],
      expected: category === "INTEGRATION"
        ? "集成者给出合入/不合入的结论 + 合入 commit（或明确冲突清单）"
        : "人类给出决定（选项/影响/推荐）+ 决策记录",
      done: category === "INTEGRATION"
        ? "集成者完成合入并在 main 可查到 commit；agent 只准备分支/证据，不自行合并。"
        : "人类拍板并留决策记录；agent 不代做。",
    };
  }

  if (category === "DATA") {
    for (const id of ids) cmds.push("node " + repoRoot + "/scripts/lookup-task.cjs " + id);
    cmds.push("PGPASSWORD=$(cat " + repoRoot + "/run/pg-password) psql -h 127.0.0.1 -U lions -d lions_mind -Atc 'select current_database()'");
    return {
      commands: [...new Set(cmds)],
      expected: "改前/改后各一条 SQL 与原始输出（行数/状态变化）+ 涉及的库内 id；不需要文件 commit",
      done: "目标数据已改且改前/改后证据齐全；若无数据可改，逐字写『本任务无文件改动』+ 未改的 SQL 依据。",
    };
  }

  if (category === "DOC") {
    for (const p of paths) cmds.push("test -s " + repoRoot + "/" + p + " && echo FILE_OK || echo FILE_MISSING");
    for (const p of paths) cmds.push("git -C " + repoRoot + " log --oneline -3 -- " + p);
    cmds.push("cd " + WORKTREE_ROOT + "/<你的 agent-id> && git status --porcelain");
    return {
      commands: [...new Set(cmds)],
      expected: "文档路径存在且非空（FILE_OK）+ git log 能看到本次提交 + worktree 状态干净",
      done: "文档已落盘并提交（或核对后确实无需改动，逐字写『本任务无文件改动』+ 证据）。",
    };
  }

  if (kind === "LANDING") {
    cmds.push("cd " + WORKTREE_ROOT + "/<你的 agent-id> && git status --porcelain");
  }
  cmds.push("git -C " + repoRoot + " log --oneline -5");
  for (const p of paths) cmds.push("git -C " + repoRoot + " log --oneline -3 -- " + p);
  for (const sha of shas) {
    cmds.push("git -C " + repoRoot + " cat-file -t " + sha + " && git -C " + repoRoot + " merge-base --is-ancestor " + sha + " main && echo IN_MAIN");
  }
  for (const id of ids) {
    // 查不到 = 该 id 不是任务/待办引用(可能是 practice id), 命令本身不预设结论。
    cmds.push("node " + repoRoot + "/scripts/lookup-task.cjs " + id);
  }

  const expected =
    kind === "LANDING"
      ? "git status --porcelain 为空(改动已提交) + git log -1 --stat 含本次文件 + 复测命令退出码 0/输出与期望一致 + 至少 1 段三反引号包裹的原始 stdout"
      : "明确结论(已闭环/仍需做/无法判定) + 至少 3 条可复算锚点(库内 id/状态、commit、文件:行、命令原始输出)";
  const done =
    kind === "LANDING"
      ? "文件改动已提交且复测通过, 并在产出里贴三反引号包裹的原始 stdout; 若核对后确实无需改动, 逐字写『本任务无文件改动』+ 证据(闸门认这句)。"
      : "结论 + 证据锚点齐全即算完成(不要求改文件); 无证据的结论不算完成。";
  return { commands: [...new Set(cmds)], expected, done };
}

/**
 * 组装任务规格。标题/描述/验收标准/hint 的唯一来源。
 * 描述刻意"动作先行": 第一行就是【要做什么】, 把 900 字叙事压到背景里 <=180 字。
 */
export function buildLeftoverTaskSpec(input: LeftoverTaskSpecInput): LeftoverTaskSpec {
  const repo = input.repoRoot || DEFAULT_REPO;
  const text = String(input.text || "").trim();
  const category = input.category || classifyLeftoverCategory(text).category;
  const kind = input.category ? kindForCategory(category) : input.kind;
  // 只有**显式** category 才强制人类前缀; 自动判类别用于标签/命令, 不改变历史调用方的标题语义。
  const forceHuman = input.humanDecision === true || input.category === "HUMAN" || input.category === "INTEGRATION";
  const titlePrefix = forceHuman ? "[需人类决策]" : kind === "VERIFY" ? "[验证]" : "[落地]";
  const title = (titlePrefix + " 实践遗留: " + text).slice(0, 180);
  const deliverable = buildDeliverable(text, kind, repo, category);
  const outcome = input.practiceOutcome || "PARTIAL";
  const background = String(input.practiceContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const commandLines = deliverable.commands.map((c, i) => "  " + (i + 1) + ". " + c).join("\n");

  const description = [
    "【要做什么】" + text,
    "【类型】" + (forceHuman ? "HUMAN(需人类/集成者处理, agent 不执行)" : kind === "VERIFY" ? "VERIFY(只出结论 + 证据锚点, 不要求改文件)" : "LANDING(必须改文件并提交, 或逐字声明『本任务无文件改动』)"),
    "【类别】" + CATEGORY_LABEL[category],
    worktreeHint(repo, kind),
    "【交付定义 · 验收命令】",
    commandLines,
    "【交付定义 · 期望输出】" + deliverable.expected,
    "【交付定义 · 什么算做完】" + deliverable.done,
    "【背景】来自实践 " + input.practiceId + "(会话 " + input.sessionUid + ", outcome=" + outcome + "): " + input.practiceTitle + "。" + background,
    "【不接受的产出】①只交方案/建议/催促; ②无证据的结论; ③把已完成的部分复述一遍当交付。",
  ].join("\n");

  const acceptanceCriteria =
    "【交付定义】" + CATEGORY_LABEL[category] + "; " +
    (forceHuman ? "HUMAN: 人类/集成者给出决定或合入结论" : kind === "VERIFY" ? "VERIFY: 结论 + >=3 条可复算证据锚点" : "LANDING: 改动已提交 + 复测通过(或『本任务无文件改动』+ 证据)") +
    "; 验收命令: " + deliverable.commands[0] +
    "; 什么算做完: " + deliverable.done;

  return {
    kind,
    category,
    titlePrefix,
    title,
    description,
    requirements: "先核对现状(可能已被别的任务做掉) -> 按【交付定义】交付; 证据必须可复算。",
    acceptanceCriteria,
    deliverable,
  };
}
