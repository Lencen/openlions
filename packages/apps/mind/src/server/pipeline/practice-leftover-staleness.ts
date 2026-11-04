/**
 * 实践遗留(Practice.leftovers)陈旧性判定 —— 单一实现。
 *
 * 背景(2026-10-09, 落地遗留项 session-extract 复用):
 *   session-extract 把 Practice.leftovers 逐条转成 [落地] 改进任务(见 session-extract.ts
 *   "leftovers -> 改进任务"), 但**只按标题前缀去重**, 不检查这条遗留项描述的事**是否已经闭环**。
 *   实测事故: 实践 cmv0ygp5y00dsmzsjg 的遗留项
 *     「todo_land_tpotokfj8934 平台状态由 leader 合并 commit 871307a 后统一 submit, 执行体无平台 submit 接口」
 *   所指待办在 2026-09-15 15:11:15 已 TODO_CLOSED_BY_TASK、commit 871307a 已并入 main,
 *   10-09 却仍被重新开成 [落地] 任务 —— 一条**注定被判定为"无效/已完成"**的执行任务, 纯浪费。
 *
 * 判据一(2026-10-09, todo 引用):
 *   ① 文本里出现的**每一个** todo_<id> 引用都能在平台 Todo 表里查到, 且
 *   ② 这些待办的状态**全部**是终态(DONE/DROPPED)
 *   -> 判 stale=true, 不再开单。
 *
 * 判据二(2026-10-09 第三轮, 路径引用; 补判据一漏掉的一整类):
 *   事故: 实践 cmv0yh8eg00o124zjx7 的遗留项
 *     「docs/leo-verifies/f001-reverify-2026-09-15/ 未跟踪(上一 session 报告),本任务未提交」
 *   没有任何 todo_<id> 引用(全是路径), 判据一直接返回 stale=false("无 todo 引用, 不判陈旧"),
 *   于是同一条遗留被 session-extract **连续开了 3 次**(37a898d8 / 89113446 / 本单),
 *   每次都只需回一句"该目录 2026-09-16 已被 093f7cf4 提交进 main"。
 *   补判据: 文本含"未跟踪/未提交"标记, 且文本里出现的**每一个**仓库相对路径都已被 git 跟踪
 *   -> 该"未跟踪"描述已不成立, 判 stale=true。
 *
 * 判据三(2026-10-09 第四轮, 平台任务引用; 补判据一/二都漏掉的一类):
 *   事故: 实践 cmv0xq8ge00qp8t2z5 的遗留项
 *     「task cmv0tgcxr00bo6ldcx 仍 IN_PROGRESS 指派 agent-d,因结单闸门要求主库 main HEAD
 *       内的 commit,与工作树纪律冲突,需人决策:git log 加 --all 或对 BLOCKED 豁免 CLAIMED_EDITS_REQUIRED」
 *   引用的是一条约**平台 Task**(cmv0tgcxr00bo6ldcx), 既无 todo_<id> 也无仓库路径, 判据一/二都不命中,
 *   于是同一议题被反复开成 [落地] 任务(前任 cmv0xp5om00iqd05oy 已被 agent-d 作废,
 *   本单 cmv0xq8gp00yno2db6 是同议题的再一次)。
 *   补判据: 文本引用的平台 Task 全部查得到、且状态全部是"对自动开单无意义"的终态
 *   (DONE/DROPPED/DEPRECATED, 或 BLOCKED 隔离待人工 —— 该任务本身就是跟踪项, 不该再派执行单)。
 *
 * 为什么任务引用必须**注入 taskStatusOf 确认**(不能用正则直接判):
 *   Task id 与 Practice id 同形(都是 cm + 16 位 base36), 纯正则无法区分; 只有能在 Task 表查到的
 *   才计为"任务引用", 查不到的候选一律忽略(可能是 Practice/session id 或普通词)。
 *   这样也天然满足保守原则: 引用查不到 => 不计引用 => 不滤。
 *
 * 判据四(2026-10-26, commit 引用; 质量专项):
 *   事故: 1821 条 PENDING 里大量遗留项写着「已由既有提交 871307a 真实解决」, 仍被开成 [落地] 任务;
 *   执行体只能交回"已由既有提交解决", 闸门按 LANDING 判无改动 -> 拒 -> 放回 -> 再领(转化率 0-4%)。
 *   补判据: 文本含"已完成"语气(已修复/已解决/已合入/已由/已完成/已闭环),
 *     且该语气**紧邻(±80 字)**的 commit 引用**全部**能在 git 里查到、且都已在 main
 *     -> 该遗留项已被真实提交闭环, 不再开单。
 *   刻意保守(防误杀):
 *     · 只认紧邻 commit(远距离引用多为背景信息, 离线脚本实测 192 条即此口径);
 *     · 任一 commit 查不到 / 不在 main -> 不滤;
 *     · 同一窗口出现"未合入/不在 main/尚未/仍需"等否定标记 -> 不滤
 *       (实测原文: "c9471890 已实现…该提交不在 main" —— 这种单子恰恰要保留);
 *     · **全文**还剩"未/尚未/仍需/但"等未完成语义 -> 一律不滤
 *       (多段式遗留 "A 已由提交 X 解决, 但 B 未做" 不能被半句"已完成"误滤)。
 *
 * 保守原则(与判据一一致: 宁可漏滤不可误滤):
 *   - 判据一: 任一引用查不到(unknown)或仍活跃(OPEN/DOING) 就不滤。
 *   - 判据二: 必须**同时**满足"文本明确说未跟踪/未提交" + "提到至少一条仓库相对路径" +
 *     "每一条路径都被 git 跟踪"; 任一不满足就不滤(路径仍 untracked / 查不到 / 无标记都照常开单)。
 *
 * 为什么把 git 查询做成注入式(trackedOf)而不是在本模块里起子进程:
 *   本模块要保持**纯函数**(可单测、无 cwd/分支依赖); git 子进程与缓存放在调用方
 *   (session-extract), 判定逻辑与探针共用同一份。
 */

/** 平台 Todo 的终态: 已结 / 已丢弃。Open/Doing 都算"还活着"。 */
export const TERMINAL_TODO_STATUS: readonly string[] = ["DONE", "DROPPED"];

/**
 * 对 agent 自动开单而言"已不可再执行/已被平台跟踪"的任务状态:
 *   - DONE / DROPPED / DEPRECATED: 任务已终结, 其遗留无需再派执行单;
 *   - BLOCKED: 该任务已被租约隔离、进入人工复核队列, 它本身就是跟踪项 —— 为它再开一张
 *     [落地] 执行单是重复派单(且执行体对一个已隔离任务也没有可执行动作)。
 * 只要**任一**被引用的任务仍是 PENDING/IN_PROGRESS 等可执行态, 就不滤(保守)。
 */
export const NON_ACTIONABLE_TASK_STATUS: readonly string[] = ["DONE", "DROPPED", "DEPRECATED", "BLOCKED"];

/** 与 tasks/submit 回写、todo-store 生成口径一致(允许下划线, 长度 >= 12)。 */
const TODO_REF_RE = /todo_[a-z0-9_]{12,}/gi;

/**
 * 平台 Task/Practice 共用的 cuid 形态(`cm` + 16 位 base36)。用它做**候选**抽取,
 * 是否真的是"任务引用"由注入的 taskStatusOf 去 Task 表确认(见文件头判据三说明)。
 */
const TASK_REF_RE = /\bcm[a-z0-9]{14,26}\b/gi;

/**
 * 仓库相对路径引用: 顶层目录白名单 + 至少一段, 允许结尾斜杠(目录)。
 * 白名单避免把 URL / 普通英文词组误判成路径。
 */
const REPO_PATH_RE =
  /\b((?:docs|scripts|packages|apps|verification|prisma|tools|tests)\/[\w.@-]+(?:\/[\w.@-]+)*\/?)/g;

/**
 * "未跟踪/未提交"类文案标记。
 * 只有 leftover **明确在做这类断言**时, "路径其实已被跟踪"才构成"该断言已失效"的证据;
 * 否则(例如只是把某路径列为 outputs)不得据此滤单。
 */
const UNTRACKED_CLAIM_RE = /未跟踪|未提交|未纳入版本|untracked|not\s+committed/i;

/** "已完成"语气: 只有这类断言才让"commit 已存在"构成"该遗留已闭环"的证据。 */
const DONE_WORD_RE = /已修复|已解决|已合入|已由|无需重复|已完成|已经完成|已闭环/g;

/** 与 DONE_WORD_RE 同一窗口内的否定标记: 出现即不判陈旧(这些单子还要继续做)。 */
const NEGATIVE_IN_WINDOW_RE = /不在\s*main|未合入|未合并|尚未|还没|仍未|待合入|没有合入|未进入\s*main|仍需|还要/i;

/**
 * 全文级否定标记(2026-10-26 复查加严): commit 判据是**唯一**会因为"背景里提了一句已完成"
 * 而误滤真遗留的判据。多段式遗留常见形态: "A 已由提交 X 解决, 但 B 未做/尚未..." ——
 * 只要整段还剩任何"未/尚未/但仍/待"语义, 就不许判闭环(宁可漏滤)。
 */
const NEGATIVE_ANYWHERE_RE = /未|尚未|还没|仍需|待|但|不在\s*main|没有合入/i;

/** git commit 短/长 hash(7-40 位 hex); 要求至少含一个字母, 避免把日期/纯数字 id 当 commit。 */
const COMMIT_REF_RE = /\b[0-9a-f]{7,40}\b/gi;

export interface LeftoverStaleness {
  /** 文本里提到的待办引用(去重, 小写) */
  refs: string[];
  /** 引用中状态为终态的(形如 "todo_x:DONE") */
  resolved: string[];
  /** 引用中在 Todo 表里查不到的 */
  unknown: string[];
  /** 引用中仍活跃/其它状态的(形如 "todo_x:DOING") */
  active: string[];
  /** 文本里提到的仓库相对路径引用(去重) */
  pathRefs: string[];
  /** pathRefs 中经 trackedOf 判定"已被 git 跟踪"的 */
  trackedPaths: string[];
  /** pathRefs 中未被跟踪 / 查不到的 */
  untrackedPaths: string[];
  /** 文本里经 Task 表确认的"平台任务引用"(去重, 小写); 查不到的候选不计入 */
  taskRefs: string[];
  /** taskRefs 中状态为终态的(形如 "cmv0tgcxr00bo6ldcx:DONE") */
  resolvedTasks: string[];
  /** taskRefs 中状态仍可执行的(形如 "cmv0x...:PENDING") */
  activeTasks: string[];
  /** 文本里"已完成"语气紧邻的 commit 引用(去重、小写) */
  commitRefs: string[];
  /** commitRefs 中确认存在且已在 main 的(形如 "871307a:MAIN") */
  resolvedCommits: string[];
  /** commitRefs 中未确认的(不存在 / 不在 main; 形如 "c9471890:NOT_IN_MAIN") */
  openCommits: string[];
  /** true = 该遗留项确定已闭环, 不应再开单 */
  stale: boolean;
  /** 人类可读的判定理由(写进计数/日志, 便于解释"为什么没开单") */
  reason: string;
}

/** 从自由文本里抽取 todo_<id> 引用(去重、小写)。 */
export function extractTodoRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || "").matchAll(TODO_REF_RE)) out.add(m[0].toLowerCase());
  return [...out];
}

/** 从自由文本里抽取仓库相对路径引用(去重, 保留原文大小写)。 */
export function extractRepoPathRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || "").matchAll(REPO_PATH_RE)) out.add(m[1]);
  return [...out];
}

/** 从自由文本里抽取 git commit 引用(去重、小写; 要求至少含一个 hex 字母)。 */
export function extractCommitRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || "").matchAll(COMMIT_REF_RE)) {
    const s = m[0].toLowerCase();
    if (/[a-f]/.test(s) && !/^\d+$/.test(s)) out.add(s);
  }
  return [...out];
}

/** git commit 状态(注入式: session-extract 起 git 子进程, 单测传内存值)。 */
export interface CommitState {
  exists: boolean;
  inMain: boolean;
}

/**
 * 从自由文本里抽取**候选**平台 id(去重、小写)。
 * 注意: Task id 与 Practice id 同形, 这里只返回候选, 真正是不是"任务引用"由调用方用
 * taskStatusOf 查 Task 表确认(见 classifyLeftoverStaleness 判据三)。
 */
export function extractTaskRefCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text || "").matchAll(TASK_REF_RE)) out.add(m[0].toLowerCase());
  return [...out];
}

/**
 * 判定一条 leftover 文本是否已闭环。
 * @param text      leftover 原文
 * @param statusOf  待办状态查询(注入式: 生产传 sqlite 查询, 探针/单测传内存 map)
 * @param trackedOf 仓库路径是否已被 git 跟踪(注入式; 省略=不判路径陈旧性, 向后兼容)
 *                  true=已跟踪 / false=未跟踪 / null|undefined=查不到(一律按"未确认"处理, 不滤)
 * @param taskStatusOf 平台 Task 状态查询(注入式; 省略=不判任务引用陈旧性, 向后兼容)。
 *                  返回 null|undefined = 该候选 id 不是任务(忽略); 返回状态字符串 = 确认为任务引用。
 * @param commitOf  commit 状态查询(注入式; 省略=不判 commit 陈旧性, 向后兼容)。
 *                  返回 null|undefined = 查不到/未确认(不滤); {exists,inMain} = 已确认。
 */
export function classifyLeftoverStaleness(
  text: string,
  statusOf: (todoId: string) => string | null | undefined,
  trackedOf?: (repoPath: string) => boolean | null | undefined,
  taskStatusOf?: (taskId: string) => string | null | undefined,
  commitOf?: (sha: string) => CommitState | null | undefined
): LeftoverStaleness {
  const refs = extractTodoRefs(text);
  const resolved: string[] = [];
  const unknown: string[] = [];
  const active: string[] = [];
  for (const id of refs) {
    const st = String(statusOf(id) || "").trim().toUpperCase();
    if (!st) unknown.push(id);
    else if (TERMINAL_TODO_STATUS.includes(st)) resolved.push(id + ":" + st);
    else active.push(id + ":" + st);
  }
  const todoStale = refs.length > 0 && unknown.length === 0 && active.length === 0;

  const pathRefs = extractRepoPathRefs(text);
  const claimsUntracked = UNTRACKED_CLAIM_RE.test(text);
  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  if (trackedOf && claimsUntracked) {
    for (const p of pathRefs) {
      let t: boolean | null | undefined = null;
      try {
        t = trackedOf(p);
      } catch {
        t = null; // 查询失败 = 未确认, 不据此滤单
      }
      if (t === true) trackedPaths.push(p);
      else untrackedPaths.push(p);
    }
  }
  const pathStale =
    !!trackedOf &&
    claimsUntracked &&
    pathRefs.length > 0 &&
    trackedPaths.length === pathRefs.length &&
    untrackedPaths.length === 0;

  // ---- 判据三: 平台任务引用 ----
  // 候选 id 逐个查 Task 表: 查不到 = 不是任务(忽略); 查到 = 计入 taskRefs, 按是否终态分流。
  const taskRefs: string[] = [];
  const resolvedTasks: string[] = [];
  const activeTasks: string[] = [];
  if (taskStatusOf) {
    for (const id of extractTaskRefCandidates(text)) {
      let st: string | null | undefined = null;
      try {
        st = taskStatusOf(id);
      } catch {
        st = null; // 查询失败 = 未确认, 不据此滤单
      }
      const s = String(st || "").trim().toUpperCase();
      if (!s) continue; // 不是任务(可能是 practice/session id), 忽略
      taskRefs.push(id);
      if (NON_ACTIONABLE_TASK_STATUS.includes(s)) resolvedTasks.push(id + ":" + s);
      else activeTasks.push(id + ":" + s);
    }
  }
  const taskStale = taskRefs.length > 0 && activeTasks.length === 0;

  // ---- 判据四: "已完成"语气紧邻的 commit ----
  // 只认紧邻 ±80 字内的 commit; 出现否定标记(未合入/不在 main/尚未…)就不滤。
  const commitRefs: string[] = [];
  const resolvedCommits: string[] = [];
  const openCommits: string[] = [];
  let commitNegative = false;
  if (commitOf) {
    const near = new Set<string>();
    for (const m of String(text || "").matchAll(DONE_WORD_RE)) {
      const at = m.index ?? 0;
      const win = String(text || "").slice(Math.max(0, at - 80), at + m[0].length + 80);
      if (NEGATIVE_IN_WINDOW_RE.test(win)) commitNegative = true;
      for (const sha of extractCommitRefs(win)) near.add(sha);
    }
    for (const sha of near) {
      commitRefs.push(sha);
      let st: CommitState | null | undefined = null;
      try {
        st = commitOf(sha);
      } catch {
        st = null; // 查询失败 = 未确认, 不据此滤单
      }
      if (st && st.exists && st.inMain) resolvedCommits.push(sha + ":MAIN");
      else openCommits.push(sha + ":" + (st && st.exists ? "NOT_IN_MAIN" : "UNKNOWN"));
    }
  }
  const commitStale = commitRefs.length > 0 && !commitNegative && openCommits.length === 0 && !NEGATIVE_ANYWHERE_RE.test(String(text || ""));

  const stale = todoStale || pathStale || taskStale || commitStale;

  // ---- reason: 把三条判据的判定过程都写清楚, 便于解释"为什么没开单/为什么还开" ----
  const parts: string[] = [];
  if (refs.length === 0) parts.push("无 todo 引用");
  else if (todoStale) parts.push("引用的待办全部已终态(" + resolved.join(", ") + ")");
  else parts.push("todo 引用未全部闭环(unknown=" + unknown.join(",") + "; active=" + active.join(",") + ")");
  if (claimsUntracked && pathRefs.length > 0) {
    if (pathStale) {
      parts.push(
        "且『未跟踪/未提交』所指路径全部已被 git 跟踪(" + trackedPaths.join(", ") + "), 该断言已不成立"
      );
    } else if (!trackedOf) {
      parts.push("含路径引用(" + pathRefs.join(", ") + ")但未注入 git 跟踪查询, 路径陈旧性不判");
    } else {
      parts.push("含路径引用但未全部被跟踪(untracked=" + untrackedPaths.join(",") + ")");
    }
  }
  if (taskRefs.length > 0) {
    if (taskStale) {
      parts.push("且引用的平台任务全部为终态/隔离态(" + resolvedTasks.join(", ") + "), 该遗留已有跟踪项, 不再开执行单");
    } else {
      parts.push("引用的平台任务仍可执行(active=" + activeTasks.join(",") + ")");
    }
  }
  if (commitRefs.length > 0) {
    if (commitStale) {
      parts.push("且『已完成』语气紧邻的 commit 全部已存在于 main(" + resolvedCommits.join(", ") + ")");
    } else {
      parts.push(
        "含『已完成』语气紧邻的 commit 但未全部确认在 main(open=" + openCommits.join(",") + ")" +
          (commitNegative ? ", 且文案含未合入/不在 main 等否定标记" : "")
      );
    }
  }
  const reason =
    (stale ? "遗留项已闭环, 不再开单: " : "不判陈旧: ") + parts.join("; ");

  return {
    refs, resolved, unknown, active,
    pathRefs, trackedPaths, untrackedPaths,
    taskRefs, resolvedTasks, activeTasks,
    commitRefs, resolvedCommits, openCommits,
    stale, reason,
  };
}
