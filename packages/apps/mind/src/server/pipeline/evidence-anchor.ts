import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { prisma } from "@/lib/prisma";
import { resolveRepoRoot } from "@/server/lib/repo-root";

/**
 * evidence-anchor.ts — 2026-09-15 「收口自检」的证据锚点探测器。
 *
 * 为什么需要它(任务 cmu24ffju084dki4a5khu22g8 第 2 步):
 *   实测 165 条 DONE 任务的 acceptance evidence-attached 全灭 —— 产出是"通道回执", 没有任何可复算锚点。
 *   任务状态却是 DONE: 对外是假象。只改派单路由(第 1 步)能防新账, 但防不住"领到活却交不出证据"的旧行为。
 *   所以在 **submit 结单之前**加一道自检: 取证必需型任务(机制修复/落地/复核/补证)的产出若一个锚点都没有,
 *   拒绝置 DONE(422 EVIDENCE_REQUIRED), 并明确告诉执行体缺什么、怎么补 —— 收口, 而不是事后判 FAIL。
 *
 * 与验收探针同源: 锚点口径逐条对照 scripts/acceptance/lib/verdict-authority.cjs 的「证据锚点」段
 *   (cmd 正则 / 库内 id 存在性 / 仓库文件存在性 / commit 存在性 / 可溯源引文)。两边都用同一批正则与同一套
 *   norm/窗口引文算法, 由 scripts/test-evidence-routing.ts 的固定用例交叉验证是否漂移。
 */

// 2026-10-23 修：服务以 WorkingDirectory=~ 启动且没有 LIONS_REPO，
//   原来的 REPO=process.cwd() 变成 ~ —— 于是"仓库文件存在性"和"commit 存在性"两项永远失败，
//   实测 24h 内 327 次结单被判"无可复算证据锚点"，而产出里其实有真实分支/提交/文件路径。
const REPO = resolveRepoRoot();

// 与 verdict-authority.cjs 完全一致(改一处必须改两处, 由 test-evidence-routing.ts 的一致性用例守着)。
export const EVIDENCE_CMD_RE = /(?:^|[\s`'"(\[{])(jq|sqlite3|curl|git|grep|rg|node|bash|sh|python3?|pnpm|npm|npx|cat|ls|sed|awk|find)\s+\S|\bSELECT\b[^\n;]{0,120}\bFROM\b|\bUPDATE\b[^\n;]{0,80}\bSET\b/i;
// 2026-10-23 扩围：原正则只认 packages|scripts|docs|apps，而 agent 产出最常引用 verification/ 下的取证文件，
//   也常直接写绝对路径 ~/lions/...。两种都会被判"文件锚点 0"→ 误拒。
export const EVIDENCE_PATH_RE = /(?:\/home\/operator\/lions\/)?(?:packages|scripts|docs|apps|verification)\/[\w.@/-]+\.(?:tsx|jsx|json|cjs|mjs|ts|js|py|sh|md|css)/g;
export const EVIDENCE_ID_RE = /\bcm[a-z0-9]{20,}\b/g;
const BOILER = /诚实标注|本通道无工具|改进判断\/方案建议|由 agent\(/;

export interface EvidenceAnchorResult {
  ok: boolean;
  /** 命中的锚点(人可读; 与探针 ANCHORS 行同构) */
  anchors: string[];
  counts: { cmd: number; dbId: number; dbIdExists: number; file: number; fileExists: number; commit: number; quoteVerified: number; quoteWindow: number };
  /** 未过时可读的"缺什么"说明 */
  detail: string;
}

/** 与探针同源的归一化(去反斜杠转义/空白/引号) */
const norm = (s: string): string =>
  String(s || "").replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\/g, "").replace(/[\s\u3000]+/g, "").replace(/[「」『』“”"']/g, "");

async function dbIdExists(id: string): Promise<boolean> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT 1 x FROM Task WHERE id=? UNION SELECT 1 FROM TaskExecution WHERE id=? UNION SELECT 1 FROM Knowledge WHERE id=? " +
        "UNION SELECT 1 FROM FlywheelEvent WHERE id=? UNION SELECT 1 FROM Output WHERE id=? LIMIT 1",
      id, id, id, id, id,
    );
    return !!(rows && rows.length);
  } catch {
    return false;
  }
}

async function knowledgeContains(prefix: string): Promise<boolean> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe("SELECT 1 x FROM Knowledge WHERE content LIKE ? LIMIT 1", "%" + prefix + "%");
    return !!(rows && rows.length);
  } catch {
    return false;
  }
}

/**
 * 检测产出文本里的可复算证据锚点。matsText = 任务 title/description/requirements/materials 的拼接
 * (用于"引文可在材料里溯源"判定; 注意: 判定用的是**产出自己的引文**, 不是扫材料里有没有 VERDICT)。
 */
export async function detectEvidenceAnchors(text: string, matsText = ""): Promise<EvidenceAnchorResult> {
  const t = String(text || "");

  // ① 命令/SQL
  const cmdHits = [...new Set(t.match(new RegExp(EVIDENCE_CMD_RE.source, "gi")) || [])].map((s) => s.trim().slice(0, 60));

  // ② 库内 id(真实存在才算锚点)
  const ids = [...new Set(t.match(EVIDENCE_ID_RE) || [])];
  const idExists: string[] = [];
  for (const id of ids.slice(0, 40)) {
    if (await dbIdExists(id)) idExists.push(id);
  }

  // ③ 仓库文件
  const paths = [...new Set((t.match(EVIDENCE_PATH_RE) || []).map((p) => (p.startsWith("/") ? p : p)))];
  const pathsExist = paths.filter((p) => {
    const rel = p.includes("~/lions/") ? p.split("~/lions/")[1] : p;
    return fs.existsSync(path.join(REPO, rel));
  });

  // ④ commit
  const hashes = [...new Set([...t.matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]))].slice(0, 8);
  const commits = hashes.filter((h) => spawnSync("git", ["-C", REPO, "cat-file", "-e", h + "^{commit}"], { encoding: "utf8" }).status === 0);

  // ⑤ 可溯源引文: 产出里引用的长引文能在材料/Knowledge 里溯源
  const matsN = norm(matsText);
  const quotes = [...new Set([...t.matchAll(/[「『“"《]([^」』”"》]{12,200})[」』”"》]/g)].map((m) => norm(m[1])).filter((q) => q.length >= 12))];
  let quotedVerified = 0;
  for (const q of quotes.slice(0, 6)) {
    if (matsN.includes(q)) { quotedVerified++; continue; }
    if (await knowledgeContains(q.slice(0, 40))) quotedVerified++;
  }
  // 窗口引文(与探针同一算法: 30 字归一化窗口在材料里出现 >=2 次)
  let windowQuote = 0;
  for (let i = 0; i + 30 <= t.length && i < 8000; i += 10) {
    const w = norm(t.slice(i, i + 30));
    if (w.length < 30 || BOILER.test(w)) continue;
    if (matsN.includes(w)) { windowQuote++; if (windowQuote >= 2) break; }
  }

  const anchors: string[] = [];
  if (idExists.length) anchors.push("db-id:" + idExists.slice(0, 3).join(","));
  if (pathsExist.length) anchors.push("file:" + pathsExist.slice(0, 3).join(","));
  if (commits.length) anchors.push("commit:" + commits.slice(0, 3).join(","));
  if (cmdHits.length) anchors.push("cmd:" + cmdHits.slice(0, 3).join(" | "));
  if (quotedVerified) anchors.push("quote-verified:" + quotedVerified);
  if (windowQuote >= 2) anchors.push("quote-window:" + windowQuote);

  const counts = {
    cmd: cmdHits.length, dbId: ids.length, dbIdExists: idExists.length,
    file: paths.length, fileExists: pathsExist.length, commit: commits.length,
    quoteVerified: quotedVerified, quoteWindow: windowQuote,
  };
  const ok = anchors.length > 0;
  const detail = ok
    ? "命中锚点: " + anchors.join(" ; ")
    : `产出里没有任何可复算证据锚点(命令/SQL 0, 真实库 id ${idExists.length}/${ids.length}, 真实仓库文件 ${pathsExist.length}/${paths.length}, 真实 commit ${commits.length}, 可溯源引文 ${quotedVerified})`;
  return { ok, anchors, counts, detail };
}
