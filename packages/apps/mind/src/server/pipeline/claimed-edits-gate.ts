/**
 * claimed-edits-gate.ts — 结单闸门「代码/落地类任务必须真改过文件」的规则加载与评估 (2026-09-23)
 *
 * 为什么抽出来(机制修复 todo_e53950f0a49d477aa415):
 *   旧实现在 route.ts 内联:
 *       const mod = require(path.join(repoRoot, "scripts/acceptance/checks/claimed-edits.cjs"));
 *   Next.js 的 webpack 编译会把**运行时表达式**的裸 require 改写成 __webpack_require__(<绝对路径字符串>),
 *   运行时抛 `Cannot find module '" + (process.env.LIONS_HOME || process.cwd()) + "/scripts/acceptance/checks/claimed-edits.cjs'`。
 *   该异常被 catch 后 fail-open 放行 —— 于是这道「改动声明必须真提交」的防线从未生效。
 *   实测证据: FlywheelEvent 里 SUBMIT_CLAIMED_EDITS_ERROR = 94 次, 成功事件 = 0 次 (2026-09-18 12:38 ~ 09-23 09:52)。
 *
 * 修法(根因, 不是改文案) —— 两阶段:
 *   阶段一(c7f80d6)把加载抽到本模块并尝试 `createRequire()`, 但**实测未生效**:
 *     App Router(RSC) 层 webpack 会把 `import { createRequire } from "module"` 的调用**静态替换成 undefined**,
 *     编译产物里逐字是 `const req = /* createRequire() *\/ undefined;` -> 运行时 `req is not a function`,
 *     照样被 catch 后 fail-open(事件从 ERROR(Cannot find module) 变成 UNAVAILABLE(req is not a function), 闸门仍失效)。
 *     上一版的 pages-router 探针之所以"通过", 是因为 pages 层走 CJS external, 编译方式与 App Router 不同 -> 假阳性。
 *   阶段二(本文件, todo_e53950f0a49d477aa415 二次修复):
 *     ① `process.getBuiltinModule("module").createRequire` —— 运行时属性访问, webpack 不静态改写(Node >= 22.3);
 *     ② 兜底: 读 .cjs 源码 + `new Function` 注入最小 require(fs/path/better-sqlite3 stub) 求值, 只暴露纯函数。
 *   两条路径都加载**同一份** scripts/acceptance/checks/claimed-edits.cjs(单一规则源, 与 code-change.json 的
 *   claimed-edits-committed 同源)。
 *
 * 口径(与旧内联实现一致, 未改判据):
 *   - 只有 extractClaimedPaths 返回 claim=true 的路径才算「我改了它」;
 *   - 0 个声明 -> CLAIMS_REQUIRED(route 侧映射 422);
 *   - 声明的文件在任务窗口 [sinceIso, nowIso] 内没有任何 git 提交 -> NO_COMMIT_IN_WINDOW(route 侧映射 422);
 *   - 规则库加载不到 -> UNAVAILABLE(fail-open 放行并留痕, 不 fail-closed, 避免一次路径问题锁死所有代码类结单);
 *   - 评估抛异常 -> ERROR(fail-open 放行并留痕)。
 *
 * 2026-10-09 机制修复(practice cmv0xp5oa00a3r0u3m 的遗留项, 同日先由 cmv0tgcxr00bo6ldcx 实测复现):
 *   问题: defaultCommitCounter 在 repoRoot(" + (process.env.LIONS_HOME || process.cwd()) + ") 上跑 `git log --since --until -- <path>`,
 *     **不带 --all**, 即只沿 HEAD(main) 回溯。而并发写纪律(2026-09-15 起)要求 agent 只在自己的
 *     工作树分支(agent/<name>)提交, 由集成者稍后 --merge 回 main。于是任何遵守纪律的 agent,
 *     其 LANDING 类任务在**合并回 main 之前**, 声明的改动在 main HEAD 里都查不到 -> 恒判
 *     NO_COMMIT_IN_WINDOW(422), 无法走 tasks/submit 结单; 且该闸不区分 target, 连"如实交回"也被同一道闸挡住。
 *   修法: 提交计数纳入**所有本地/远端引用**(`git log --all`), 让 agent/* 工作树分支上的窗口内提交被承认。
 *     这是根因修复(承认既有纪律下的真实提交), 不是放宽判据: 仍要求声明的路径在任务窗口内确有提交对象。
 *   残留(未改): 闸门仍不做作者归属校验(--all 会把任何分支上的窗口内提交计入), 与修复前一样不校验 author;
 *     若要"必须是你本人提交", 需另开单引入 --author=agent 或按 worktree 解析, 属新需求。
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/** 验收侧规则库相对仓库根的路径(单一规则源) */
export const RULE_REL = "scripts/acceptance/checks/claimed-edits.cjs";

export type ClaimedPath = { path: string; claim: boolean; lines: number };
export type ClaimedEditsRules = {
  extractClaimedPaths: (text: string) => ClaimedPath[];
  // 2026-10-12 round 72-AZ: 免改动声明判定(见 ClaimedEditsVerdict 的 NO_CHANGE_DECLARED)。
  //   可选 —— 规则模块若还是旧版就没这个函数, 此时退回原行为(不 fail-open, 只是没有免改动通道)。
  hasNoChangeDeclaration?: (text: string) => boolean;
};

/** 仓库根候选: 先环境变量, 再本机约定路径, 再相对 cwd 的上跳(与旧内联实现同候选) */
export function candidateRoots(cwd: string = process.cwd()): string[] {
  const env = String(process.env.LIONS_REPO_ROOT || "").trim();
  return [
    env,
    "" + (process.env.LIONS_HOME || process.cwd()) + "",
    path.resolve(cwd, "../../../"),
    path.resolve(cwd, "../../../../"),
  ].filter(Boolean);
}

/** 找到第一个真正含规则库的仓库根; 找不到返回 "" */
export function findRepoRoot(cwd: string = process.cwd()): string {
  for (const r of candidateRoots(cwd)) {
    try { if (fs.existsSync(path.join(r, RULE_REL))) return r; } catch { /* 忽略不可读候选 */ }
  }
  return "";
}

/**
 * 取一个"真正的 Node require" —— **webpack 安全**(见文件头 2026-09-23 阶段二说明)。
 * 用 `process.getBuiltinModule`(运行时属性访问, webpack 不静态改写)拿原生 module 模块的 createRequire。
 * @returns req 为 null 表示该运行时拿不到, 调用方走源码求值兜底。
 */
export function getNodeRequire(repoRoot: string): { req: ((id: string) => unknown) | null; via: string } {
  const g = (process as unknown as { getBuiltinModule?: (id: string) => any }).getBuiltinModule;
  if (typeof g === "function") {
    try {
      const m = g("module");
      if (m && typeof m.createRequire === "function") {
        return { req: m.createRequire(path.join(repoRoot, "package.json")) as (id: string) => unknown, via: "process.getBuiltinModule('module').createRequire" };
      }
    } catch { /* 落到源码求值兜底 */ }
  }
  return { req: null, via: "none" };
}

/**
 * 兜底加载: 读 .cjs 源码, 用 `new Function` 注入最小 require 求值。
 * webpack 不改写 `new Function`, 因此这条路在 App Router 层也稳。
 * 只提供纯函数所需依赖(fs/path); better-sqlite3 只被 CLI 分支用到, 给一个抛错 stub,
 * 且 `require.main === module` 守卫会把 CLI 分支整体挡掉(注入的 module 无 main)。
 */
export function evalRulesSource(target: string): ClaimedEditsRules {
  // 与 Node 的 CJS loader 对齐: 去掉 BOM 与文件头 shebang(`#!...`), 否则 new Function 会 SyntaxError。
  const src = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "").replace(/^#![^\n]*/, "");
  const modObj: { exports: ClaimedEditsRules } = { exports: {} as ClaimedEditsRules };
  const shimRequire = (id: string): unknown => {
    if (id === "fs" || id === "node:fs") return fs;
    if (id === "path" || id === "node:path") return path;
    if (id === "better-sqlite3") {
      return function betterSqlite3Stub(): never { throw new Error("better-sqlite3 stub: 闸门只加载纯函数, 不执行 CLI"); };
    }
    return {};
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("require", "module", "exports", "__filename", "__dirname", src) as (
    r: (id: string) => unknown, m: { exports: ClaimedEditsRules }, e: ClaimedEditsRules, f: string, d: string,
  ) => void;
  fn(shimRequire, modObj, modObj.exports, target, path.dirname(target));
  return modObj.exports;
}

/**
 * 加载验收侧规则库(单一规则源 scripts/acceptance/checks/claimed-edits.cjs)。
 * 依次尝试: ① process.getBuiltinModule createRequire ② 源码求值兜底。
 * 返回 { repoRoot, mod, error, via }; mod==null 时 error 说明每条路径失败的原因。
 */
export function loadClaimedEditsRules(opts: { cwd?: string; repoRoot?: string } = {}): { repoRoot: string; mod: ClaimedEditsRules | null; error?: string; via?: string } {
  const repoRoot = opts.repoRoot !== undefined ? opts.repoRoot : findRepoRoot(opts.cwd || process.cwd());
  if (!repoRoot) return { repoRoot: "", mod: null, error: "未找到含 " + RULE_REL + " 的仓库根" };
  const target = path.join(repoRoot, RULE_REL);
  if (!fs.existsSync(target)) return { repoRoot, mod: null, error: "规则库不存在: " + target };
  const errors: string[] = [];

  // ① 原生 createRequire(webpack 安全路径)
  const nr = getNodeRequire(repoRoot);
  if (nr.req) {
    try {
      const mod = nr.req(target) as ClaimedEditsRules;
      if (mod && typeof mod.extractClaimedPaths === "function") return { repoRoot, mod, via: nr.via };
      errors.push(nr.via + ": 加载成功但缺少 extractClaimedPaths 导出");
    } catch (e) {
      errors.push(nr.via + ": " + String((e as Error)?.message || e));
    }
  } else {
    errors.push("process.getBuiltinModule('module') 不可用");
  }

  // ② 源码求值兜底
  try {
    const mod = evalRulesSource(target);
    if (mod && typeof mod.extractClaimedPaths === "function") return { repoRoot, mod, via: "evalRulesSource(new Function)" };
    errors.push("evalRulesSource: 缺少 extractClaimedPaths 导出");
  } catch (e) {
    errors.push("evalRulesSource: " + String((e as Error)?.message || e));
  }

  return { repoRoot, mod: null, error: errors.join(" | ") };
}

export type CommitCounter = (repoRoot: string, sinceIso: string | null, nowIso: string, p: string) => number;

/**
 * 默认提交计数: `git log --format=%H --all --since/--until -- <path>`。
 * 2026-10-09: 加 `--all` —— 旧实现不带它, 只见 main HEAD, 与"agent 只在自己工作树分支提交"的
 *   并发写纪律冲突, 使 worktree 分支上的真实提交在合并前查不到(practice cmv0xp5oa00a3r0u3m 遗留项)。
 *   `--all` 让 refs/ 下所有引用(含 agent/* 工作树分支、远端、标签)+ HEAD 都参与回溯。
 */
export function defaultCommitCounter(repoRoot: string, sinceIso: string | null, nowIso: string, p: string): number {
  try {
    const args = ["log", "--format=%H", "--all"];
    if (sinceIso) args.push("--since=" + sinceIso);
    args.push("--until=" + nowIso, "--", p);
    const out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 20000 }).trim();
    return out ? out.split("\n").filter(Boolean).length : 0;
  } catch { return 0; }
}

export type ClaimedEditsVerdict =
  | { status: "UNAVAILABLE"; repoRoot: string; error: string }
  // 2026-10-12 round 72-AZ: 「本任务无文件改动」免改动声明 —— 平台自己的任务描述就要求执行体
  //   在"核对后发现已由别的任务完成"时如实标注『无需改动』, 而此前闸门对 0 声明一律 422, 没有出口
  //   (本文件下方注释亦承认"连'如实交回'也被同一道闸挡住")。实测 247/281 个被拒任务最终 BLOCKED。
  //   本状态**放行**但必须**留痕**: route 侧写 SUBMIT_NO_CHANGE_DECLARED 事件 -> 比例可见、可收紧。
  //   不构成"纯文本逃逸": 本闸门之前已有 EVIDENCE_REQUIRED 闸门(代码/落地类强制要可复算证据锚点)。
  | { status: "NO_CHANGE_DECLARED"; repoRoot: string; claims: number }
  | { status: "CLAIMS_REQUIRED"; repoRoot: string; claims: number }
  | { status: "NO_COMMIT_IN_WINDOW"; repoRoot: string; claims: number; per: string[]; sinceIso: string | null }
  | { status: "OK"; repoRoot: string; claims: number; hits: number; per: string[] }
  | { status: "ERROR"; repoRoot: string; error: string };

/** 评估闸门。countCommits 可注入以便单测; 默认走 git。 */
export function evaluateClaimedEdits(input: {
  output: string;
  sinceIso: string | null;
  nowIso: string;
  repoRoot?: string;
  cwd?: string;
  countCommits?: CommitCounter;
  maxClaims?: number;
}): ClaimedEditsVerdict {
  const loaded = loadClaimedEditsRules({ cwd: input.cwd, repoRoot: input.repoRoot });
  if (!loaded.repoRoot || !loaded.mod) return { status: "UNAVAILABLE", repoRoot: loaded.repoRoot, error: loaded.error || "规则库不可用" };
  try {
    const claims = (loaded.mod.extractClaimedPaths(String(input.output || "")) || []).filter((c) => c && c.claim);
    if (claims.length === 0) {
      // 免改动声明优先于 CLAIMS_REQUIRED —— 见 NO_CHANGE_DECLARED 注释。
      //   规则模块若是旧版(没有该函数), 就退回原行为(不 fail-open, 只是没有免改动通道)。
      const hasDecl = typeof loaded.mod.hasNoChangeDeclaration === "function" ? loaded.mod.hasNoChangeDeclaration(String(input.output || "")) : false;
      if (hasDecl) return { status: "NO_CHANGE_DECLARED", repoRoot: loaded.repoRoot, claims: 0 };
      return { status: "CLAIMS_REQUIRED", repoRoot: loaded.repoRoot, claims: 0 };
    }
    const count = input.countCommits || defaultCommitCounter;
    const max = input.maxClaims ?? 8;
    const per: string[] = [];
    let hits = 0;
    for (const c of claims.slice(0, max)) {
      const n = count(loaded.repoRoot, input.sinceIso, input.nowIso, String(c.path));
      if (n > 0) hits++;
      per.push(c.path + "=" + n);
    }
    if (hits === 0) return { status: "NO_COMMIT_IN_WINDOW", repoRoot: loaded.repoRoot, claims: claims.length, per, sinceIso: input.sinceIso };
    return { status: "OK", repoRoot: loaded.repoRoot, claims: claims.length, hits, per };
  } catch (e) {
    return { status: "ERROR", repoRoot: loaded.repoRoot, error: String((e as Error)?.message || e) };
  }
}
