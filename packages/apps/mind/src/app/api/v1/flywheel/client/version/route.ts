import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

// 2026-10-15 round-78: 本路由每次请求读磁盘上的 CLIENT_VERSION + 各组件文件并算 sha256,
//   是 agent 客户端自更新的版本源。无参 GET 无 dynamic -> build 期冻结(实测 x-nextjs-cache: HIT,
//   冻结版本 2026-09-25.0)。冻结后 scripts/macs-responder/ 的变更不下发, 且与动态的
//   /api/v1/flywheel/client/file(取 req -> 天然动态)的**文件内容不一致**: 客户端被告知旧版本号、
//   却下到新文件 -> 正是该接口要消灭的版本漂移。故必须动态。
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/flywheel/client/version — 平台客户端统一版本接口 (2026-09-16)
 *
 * 背景: agent 客户端(macs_responder.py + todo_worker.py + lib/)是"每台终端各自部署",
 *   曾出现版本漂移/组件缺失(如 lib/platform_context.py 三端都缺)。现在用**一个统一大版本号**
 *   (scripts/macs-responder/CLIENT_VERSION)管理整个客户端包。
 *
 * 返回:
 *   { version: "2026-09-16.4", components: {"macs_responder.py": "<sha>", ...},
 *     update: { method: "api-pull", fileUrl: "/api/v1/flywheel/client/file?name=" } }
 *
 * agent 客户端启动时调用: 版本不一致 -> 按 components 逐个下载替换(见 file 接口) -> 更新本地
 * CLIENT_VERSION -> 重启生效。
 */
/**
 * 2026-11-02 P0（三环境 500）：安装根下的 scripts/ 可能不存在——成品布局是 <root>/current/scripts，
 * 原来写死 <LIONS_HOME>/scripts/macs-responder，于是 test/prod 直接 ENOENT 500
 * （实测 /opt/lions/sales/scripts/macs-responder/CLIENT_VERSION 缺失）。
 * 改为按优先级探测，第一份含 CLIENT_VERSION 的目录生效；全部缺失时仍返回旧路径，
 * 让错误信息保留可诊断性（调用方能看到到底找了哪里）。
 */
function resolveClientDir(): string {
  const roots = [process.env.LIONS_CLIENT_ROOT, process.env.LIONS_HOME, process.cwd()].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const r of roots) {
    candidates.push(join(r, "scripts", "macs-responder"));
    candidates.push(join(r, "current", "scripts", "macs-responder"));
  }
  for (const c of candidates) {
    try {
      if (readFileSync(join(c, "CLIENT_VERSION"), "utf8").trim()) return c;
    } catch { /* 继续找下一个 */ }
  }
  return candidates[0];
}
const CLIENT_DIR = resolveClientDir();
// 2026-09-16 新增 SOP-MCP-CHAT-SERVER.md: MACS 接入规范正本纳入统一客户端包,
//   客户端自更新时一并拉取(解决 agent-x 端 sop_version 停在 1.0 的漂移问题)。
const BASE_COMPONENTS = ["macs_responder.py", "todo_worker.py", "lib/platform_context.py", "SOP-MCP-CHAT-SERVER.md"];

/**
 * 2026-11-02 P0: 自更新必须按 client-manifest.json 的必需件下发, 不能只发 4 个写死件。
 * 实测: manifest 声明 9 件, 自更新只发 4 件 -> 104 的 CLIENT_VERSION 已 2026-10-30.4,
 * 但 client-manifest.json 仍 2026-10-23.5; 版本变了、清单没变。
 * 这里把 manifest 本体 + 其 files[].required 的 src 一并纳入 components; 解析失败回落 BASE。
 */
function componentNames(): string[] {
  const names = new Set<string>([...BASE_COMPONENTS, "client-manifest.json"]);
  try {
    const m = JSON.parse(readFileSync(join(CLIENT_DIR, "client-manifest.json"), "utf8"));
    for (const f of Array.isArray(m.files) ? m.files : []) {
      const src = String(f?.src || "");
      if (f?.required && src && !src.startsWith("/") && !src.split("/").includes("..")) names.add(src);
    }
  } catch { /* 清单缺失/坏 JSON 时仍下发基础件 */ }
  return [...names];
}

// 2026-09-16.7 修复(agent-x 巡检差异3): 旧 sha1() 是自定义 31 乘哈希, 客户端无法用标准算法复现对账。
// 改用真 sha256 前 16 位, 客户端 sha256sum | cut -c1-16 即可核对。 hashAlgo=sha256-16hex
function fileHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export async function GET() {
  try {
    // 2026-11-02 P0 第二层加固（总调度：三环境 500）：
    //   即使候选目录全都缺 CLIENT_VERSION，也不许 500 —— 有发布记录就用发布记录兜底（source=release），
    //   并显式标 degraded，让调用方知道"磁盘清单缺失、版本来自 release 表"，而不是一个没有诊断信息的 500。
    let version = "";
    try {
      version = readFileSync(join(CLIENT_DIR, "CLIENT_VERSION"), "utf8").trim();
    } catch {
      version = "";
    }
    const components: Record<string, string> = {};
    for (const c of componentNames()) {
      try {
        components[c] = fileHash(readFileSync(join(CLIENT_DIR, c), "utf8"));
      } catch {
        components[c] = "missing";
      }
    }
    // SOP 元信息: 从 SOP 头部解析 sop_version + 真 sha256(MACS 服务端 ack 校验用的是 sha256)
    let sop: { version: string; sha256: string } | null = null;
    try {
      const raw = readFileSync(join(CLIENT_DIR, "SOP-MCP-CHAT-SERVER.md"), "utf8");
      const m = raw.match(/^sop_version:\s*(\S+)/m);
      sop = {
        version: m ? m[1] : "",
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
    } catch { /* SOP 文件缺失时不阻塞版本接口 */ }
    // 2026-10-29 R4：优先读 **客户端发布服务** 的 latest（portal 与自更新必须同源）。
    //   否则会出现"portal 显示新版、自更新还在推旧版"——该家族的第八种。
    //
    // 方案 A（平台数据线/前端已定）：
    //   - latest 有值 → 用它，`source: "release"`；
    //   - latest 无值（R3 首次发布前 / 服务未接入）→ 回落磁盘版本，`source: "disk"`。
    //   回落是**过渡手段**：`fallbackDeprecatedAt` 给出"首次 published 后 7 天"的弃用时间点，
    //   便于巡检/告警据此收口，避免回落长期存在后又被当成长期形态。
    let releaseLatest: any = null;
    try {
      const { findLatest, toPublic } = await import("@/server/client-release");
      const row = await findLatest();
      if (row) releaseLatest = toPublic(row);
    } catch { /* 发布服务未接入/表不存在 → 走回落，不阻断自更新 */ }

    if (!version && releaseLatest) {
      // 磁盘清单缺失时的兜底：版本以发布记录为准，组件清单为空并显式标注（避免自更新静默成功或 500）
      return Response.json({
        ok: true,
        version: releaseLatest.version,
        source: "release",
        degraded: "disk_bundle_missing",
        degradedNote: "磁盘 " + CLIENT_DIR + " 下没有 CLIENT_VERSION；version 取自 client_release 最新发布，components 为空",
        components: {},
        hashAlgo: "sha256-16hex",
        sop: null,
        release: {
          id: releaseLatest.id, platform: releaseLatest.platform, arch: releaseLatest.arch,
          sha256: releaseLatest.sha256, sizeBytes: releaseLatest.sizeBytes,
          publishedAt: releaseLatest.publishedAt, downloadUrl: releaseLatest.downloadUrl,
          signed: releaseLatest.signed,
        },
        update: { method: "api-pull", fileUrl: "/api/v1/flywheel/client/file?name=" },
      });
    }
    if (!version) {
      return Response.json({
        ok: false,
        error: "client bundle missing: 磁盘与发布记录都没有可用版本（CLIENT_DIR=" + CLIENT_DIR + "）",
      }, { status: 503 });
    }
    if (releaseLatest) {
      return Response.json({
        ok: true,
        version: releaseLatest.version,
        source: "release",
        release: {
          id: releaseLatest.id, platform: releaseLatest.platform, arch: releaseLatest.arch,
          sha256: releaseLatest.sha256, sizeBytes: releaseLatest.sizeBytes,
          publishedAt: releaseLatest.publishedAt, downloadUrl: releaseLatest.downloadUrl,
          signed: releaseLatest.signed,
        },
        components,
        hashAlgo: "sha256-16hex",
        sop,
        update: { method: "api-pull", fileUrl: "/api/v1/flywheel/client/file?name=" },
      });
    }
    return Response.json({
      ok: true,
      version,
      source: "disk",
      release: null,
      fallbackDeprecated: true,
      fallbackDeprecatedNote: "尚未有已发布版本，正在使用磁盘 CLIENT_VERSION；首次发布后 7 天内必须切换到 release 源",
      components,
      hashAlgo: "sha256-16hex",
      sop,
      update: { method: "api-pull", fileUrl: "/api/v1/flywheel/client/file?name=" },
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 500 });
  }
}
