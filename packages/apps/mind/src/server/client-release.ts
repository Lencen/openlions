/**
 * client-release.ts — 客户端版本管理服务（R2，2026-10-29）
 *
 * 设计正本: docs/productization/CLIENT-RELEASE-SERVICE-2026-10-29.md
 *
 * 两条**契约**（消费侧 console/portal 已按此实现，后端必须对齐）:
 *   1. `latest` **不存字段**，一律由查询推导：
 *        state='published' AND channel='stable' ORDER BY version DESC LIMIT 1
 *      双写"latest 指针"一定会与状态不一致，本平台已因这类双写踩过多次。
 *   2. **没有版本时不得返回空数组**冒充"发布过 0 个版本"——调用方拿 404 表示"未接入/尚未发布"。
 *
 * 时间口径：本库 timestamp 列存 **UTC 值**（会话时区是 Asia/Shanghai）→ 写入/比较都用
 *   `now() AT TIME ZONE 'UTC'`，不要用裸 now()。
 *
 * R2 范围：登记 / 列表 / latest / 下载 / 发布 / 撤销；**签名留到 R3**。
 *   因此 `publish` 在 R2 一律 409 UNSIGNED_RELEASE —— 这与设计一致（未签名不得发布），
 *   而不是"暂时允许"，避免 R3 上线前出现未签名的 stable 包。
 */
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { signBytes } from "./client-release-signing";

/**
 * 版本排序（**数值**，不是字符串）——2026-10-30 修 bug：
 *   字符串降序下 `'2026-10-30.7' > '2026-10-30.11'`（逐字符比较 `7` > `1`），
 *   导致 latest 返回 .7 而 .11 才是最该给的；客户端按 latest 自更新会**往回降级**。
 * 版本格式固定为 `YYYY-MM-DD.N`，故拆成"日期段 + 编号段"分别比较：
 *   日期段按字符串（ISO 日期字符串序等价于日期序），编号段按**整数**。
 * 列表与 latest **必须共用这一处**——两处各写一份排序，本身就是隐患。
 */
// 2026-11-05（VERSION-SPEC v2）：版本号从 YYYY-MM-DD.N 变为 YYYY.MM.DD.NN。
// 旧 ORDER BY 按 . 切分：v2 首段是 2026，旧格式首段是 2026-10-30，文本比较下旧格式更大，
// latest 会返回旧版本（客户端自更新会往回降级，契约明令禁止）。
// 修法：先把 - 和 . 统一成 .，再按 4 段整数比较，两种格式都能正确排序。
// 2026-11-05（VERSION-SPEC v2）：版本号从 YYYY-MM-DD.N 变为 YYYY.MM.DD.NN。
// 旧 ORDER BY 按 . 切分：v2 首段是 2026，旧格式首段是 2026-10-30，文本比较下旧格式更大，
// latest 会返回旧版本（客户端自更新会往回降级，契约明令禁止）。
// 修法：先把 - 和 . 统一成 .，再按 4 段整数比较，两种格式都能正确排序。
const ORDER_BY_VERSION_DESC = `ORDER BY
  split_part(regexp_replace(version, '[-.]', '.', 'g'), '.', 1)::int DESC,
  split_part(regexp_replace(version, '[-.]', '.', 'g'), '.', 2)::int DESC,
  split_part(regexp_replace(version, '[-.]', '.', 'g'), '.', 3)::int DESC,
  split_part(regexp_replace(version, '[-.]', '.', 'g'), '.', 4)::int DESC,
  "createdAt" DESC`;

export const PLATFORMS = ["linux-deb", "linux-rpm", "windows-msi", "macos-pkg"] as const;
export const CHANNELS = ["stable", "internal"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Channel = (typeof CHANNELS)[number];

export interface ClientReleaseRow {
  id: string;
  version: string;
  platform: string;
  arch: string;
  filename: string;
  sizeBytes: string | number;
  sha256: string;
  signature: string | null;
  signedBy: string | null;
  state: string;
  channel: string;
  notes: string | null;
  storagePath: string | null;
  downloadCount: number;
  publishedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * 存储目录：<root>/<version>/<filename>（不进 git）
 * 2026-11-02：支持 LIONS_CLIENT_RELEASES_DIR 显式指定 canonical 目录。
 *   背景：切流前后产物文件分散在三棵树（lions/run、/opt/lions/releases/0.4.1/run、/opt/lions/run），
 *   合并 canonical 目录时不必改代码；未设置时行为不变（LIONS_HOME/run/client-releases）。
 */
export function storageRoot(): string {
  if (process.env.LIONS_CLIENT_RELEASES_DIR) return process.env.LIONS_CLIENT_RELEASES_DIR;
  return join(process.env.LIONS_HOME || process.cwd(), "run", "client-releases");
}

/** 版本格式校验：与 CLIENT_VERSION 同形（YYYY-MM-DD.N） */
export function isValidVersion(v: string): boolean {
  const s = String(v || "").trim();
  // VERSION-SPEC v2（2026-11-04）：客户端版本改为 YYYY.MM.DD.NN（构建日 + 当日序号）。
  // 旧格式 YYYY-MM-DD.N 作为历史兼容继续接受（.48 及更早的已发布记录仍要能读）。
  return /^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}\.\d+$/.test(s);
}

export function sha256Buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────────
 * 上传 manifest 交叉校验（2026-10-30，R2 待办 #1）
 *
 * 为什么要做：上传接口原来只信 form 里的 version，再自己重算 sha256 —— 打包侧给的
 *   `release-manifest.json` **被忽略**。于是"清单承诺 A、实际上传 B"没有任何一方会报错，
 *   签名照样对 B 生效（签的是"上传的字节"，不是"清单承诺的字节"）。
 *
 * 判定顺序（每条都给可复算原因，不合并成一句 invalid）：
 *   1. manifest 必须是 JSON 对象；**出现 `signed` 字段直接拒**（正本 §3.5：构建机不签名，
 *      留着这个字段就早晚有人信，改成 true 连门都进不来）；
 *   2. manifest.version 必填且形如 YYYY-MM-DD.N；与 form.version 同时给出时必须相等；
 *   3. 重算 sha256（不信任上传值），与 manifest.files[] 里**同名条目**比对；同名条目必须唯一；
 *   4. 版本四元一致：manifest.version == 文件名版本 == client_version_file == package_version；
 *      client_version_file 与 package_version **都缺** → 按"不可校验"拒（正本 §3.5-3：不默认通过）。
 *
 * 状态码口径：409 = 与已声明的清单**冲突**（版本/摘要/尺寸/不可校验）；
 *             400 = 请求本身不合法（manifest 不是对象、字段缺失、版本格式错）。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ReleaseManifestFile {
  name?: string;
  sha256?: string;
  size?: number;
}

export interface ReleaseManifest {
  version?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  files?: ReleaseManifestFile[];
  client_version_file?: string;
  package_version?: string;
}

export type ManifestVerdict =
  | { ok: true; version: string; sha256: string; size: number; checked: string[] }
  | { ok: false; status: number; error: string; detail: string };

/** 从包名取版本（YYYY-MM-DD.N）。认不出返回空串 —— 不臆造失败。 */
export function versionFromFilename(filename: string): string {
  const base = String(filename || "").split(/[\\/]/).pop() || "";
  for (const seg of base.split("_")) {
    if (/^\d{4}-\d{2}-\d{2}\.\d+$/.test(seg)) return seg;
  }
  const m = /(\d{4}-\d{2}-\d{2}\.\d+)/.exec(base);
  return m ? m[1] : "";
}

/** 纯函数：只做判定，不碰数据库/磁盘（单测直接调）。 */
export function validateReleaseManifest(input: {
  manifest: unknown;
  buf: Buffer;
  filename: string;
  formVersion?: string;
}): ManifestVerdict {
  const checked: string[] = [];
  const raw = input.manifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "INVALID_MANIFEST", detail: "manifest 必须是 JSON 对象" };
  }
  const man = raw as ReleaseManifest;
  if (Object.prototype.hasOwnProperty.call(man, "signed")) {
    return {
      ok: false, status: 409, error: "MANIFEST_SIGNED_FORBIDDEN",
      detail: "manifest 不应包含 signed —— 构建机不签名，签名状态只来自发布服务",
    };
  }
  const version = String(man.version ?? "").trim();
  if (!version) return { ok: false, status: 400, error: "INVALID_MANIFEST", detail: "manifest.version 缺失" };
  if (!isValidVersion(version)) {
    return { ok: false, status: 400, error: "INVALID_MANIFEST", detail: "manifest.version=" + version + " 不是 YYYY.MM.DD.NN（或历史格式 YYYY-MM-DD.N）" };
  }
  const formVersion = String(input.formVersion ?? "").trim();
  if (formVersion && formVersion !== version) {
    return {
      ok: false, status: 409, error: "MANIFEST_VERSION_MISMATCH",
      detail: "form.version=" + formVersion + " ≠ manifest.version=" + version,
    };
  }
  checked.push("version");

  const actual = sha256Buf(input.buf);
  const files: ReleaseManifestFile[] = Array.isArray(man.files)
    ? man.files.filter((f) => f && typeof f === "object")
    : [];
  if (files.length === 0) {
    return { ok: false, status: 400, error: "INVALID_MANIFEST", detail: "manifest.files 缺失或为空，无法比对摘要" };
  }
  const sameName = files.filter((f) => String(f.name ?? "") === input.filename);
  const entry = sameName.length === 1 ? sameName[0] : sameName.length === 0 && files.length === 1 ? files[0] : undefined;
  if (!entry) {
    return {
      ok: false, status: 409, error: "MANIFEST_FILE_NOT_LISTED",
      detail: "manifest.files 里没有 upload=" + input.filename + " 的唯一同名条目（files=" +
        files.map((f) => String(f.name ?? "?")).join(",") + "）",
    };
  }
  const declared = String(entry.sha256 ?? "").trim().toLowerCase();
  if (!declared) {
    return { ok: false, status: 400, error: "INVALID_MANIFEST", detail: "manifest.files[].sha256 缺失" };
  }
  if (declared !== actual) {
    return {
      ok: false, status: 409, error: "MANIFEST_SHA256_MISMATCH",
      detail: "重算 sha256=" + actual.slice(0, 16) + "… ≠ manifest=" + declared.slice(0, 16) + "…（上传文件与清单不是同一份）",
    };
  }
  checked.push("sha256");
  if (entry.size != null) {
    if (Number(entry.size) !== input.buf.length) {
      return {
        ok: false, status: 409, error: "MANIFEST_SIZE_MISMATCH",
        detail: "manifest.size=" + entry.size + " ≠ 实际字节数 " + input.buf.length,
      };
    }
    checked.push("size");
  }

  const cvf = String(man.client_version_file ?? "").trim();
  const pkgv = String(man.package_version ?? "").trim();
  if (!cvf && !pkgv) {
    return {
      ok: false, status: 409, error: "MANIFEST_UNVERIFIABLE",
      detail: "manifest 缺 client_version_file 与 package_version —— 版本无法四元校验，不默认通过",
    };
  }
  if (cvf && cvf !== version) {
    return { ok: false, status: 400, error: "VERSION_MISMATCH", detail: "client_version_file=" + cvf + " ≠ " + version };
  }
  if (pkgv && pkgv !== version) {
    return { ok: false, status: 400, error: "VERSION_MISMATCH", detail: "package_version=" + pkgv + " ≠ " + version };
  }
  const fnVersion = versionFromFilename(input.filename);
  if (fnVersion && fnVersion !== version) {
    return { ok: false, status: 400, error: "VERSION_MISMATCH", detail: "文件名版本=" + fnVersion + " ≠ manifest.version=" + version };
  }
  checked.push("version_quad");

  return { ok: true, version, sha256: actual, size: input.buf.length, checked };
}

/** 对外形状：不泄露 storagePath */
export function toPublic(r: ClientReleaseRow) {
  return {
    id: r.id,
    version: r.version,
    platform: r.platform,
    arch: r.arch,
    filename: r.filename,
    sizeBytes: Number(r.sizeBytes),
    sha256: r.sha256,
    // 2026-10-30（frontend 需求）：列表/latest 一次给全**签名事实**，
    //   否则页面要显示"哪把钥匙签的"就得对每一行再发一次 /verify（N+1 请求）。
    //   背景：他们的页面曾把 `signed`(布尔) 当 `signature`(字符串) 读 → 已发布行也显示"未签名"；
    //   把 signed / signed_at / key_id 放在一起，减少"字段对不上但不报错"的空间。
    signed: r.signature != null,
    signed_at: (r as any).signedAt ?? null,
    key_id: r.signedBy ?? null,
    state: r.state,
    channel: r.channel,
    notes: r.notes,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    downloadUrl: "/api/v1/client/releases/" + r.id + "/download?v=" + encodeURIComponent(r.version),
  };
}

/**
 * latest 推导（契约 1）：**不读任何 latest 字段**。
 * 返回 null 表示"没有已发布的 stable 版本"→ 路由层必须转 404（契约 2）。
 */
export async function findLatest(platform?: string, channel: Channel = "stable"): Promise<ClientReleaseRow | null> {
  const rows: any[] = platform
    ? await (prisma as any).$queryRawUnsafe(
        `SELECT * FROM client_release WHERE state='published' AND channel=$1 AND platform=$2 ` + ORDER_BY_VERSION_DESC + ` LIMIT 1`,
        channel, platform
      )
    : await (prisma as any).$queryRawUnsafe(
        `SELECT * FROM client_release WHERE state='published' AND channel=$1 ` + ORDER_BY_VERSION_DESC + ` LIMIT 1`,
        channel
      );
  return (rows && rows[0]) || null;
}

export async function listReleases(opts: { channel?: Channel; limit?: number; platform?: string }): Promise<ClientReleaseRow[]> {
  const limit = Math.max(1, Math.min(200, Number(opts.limit || 50)));
  const args: any[] = [];
  const where: string[] = [];
  if (opts.channel) { args.push(opts.channel); where.push("channel=$" + args.length); }
  if (opts.platform) { args.push(opts.platform); where.push("platform=$" + args.length); }
  const sql = `SELECT * FROM client_release` + (where.length ? " WHERE " + where.join(" AND ") : "") +
    " " + ORDER_BY_VERSION_DESC + ` LIMIT ` + limit;
  return await (prisma as any).$queryRawUnsafe(sql, ...args);
}

export async function countReleases(): Promise<number> {
  const rows: any[] = await (prisma as any).$queryRawUnsafe("SELECT count(*)::int AS n FROM client_release");
  return Number(rows?.[0]?.n || 0);
}

export async function getRelease(id: string): Promise<ClientReleaseRow | null> {
  const rows: any[] = await (prisma as any).$queryRawUnsafe("SELECT * FROM client_release WHERE id=$1", id);
  return (rows && rows[0]) || null;
}

/** 落盘 + 登记（R2：不签名，state=draft） */
export async function createRelease(input: {
  version: string; platform: Platform; arch: string; filename: string;
  buf: Buffer; notes?: string | null; createdBy?: string | null; channel?: Channel;
}): Promise<{ ok: true; row: ClientReleaseRow } | { ok: false; status: number; error: string; detail?: string }> {
  const version = String(input.version || "").trim();
  if (!isValidVersion(version)) {
    return { ok: false, status: 400, error: "INVALID_VERSION", detail: "版本格式应为 YYYY-MM-DD.N（与 CLIENT_VERSION 同形）" };
  }
  if (!PLATFORMS.includes(input.platform)) {
    return { ok: false, status: 400, error: "INVALID_PLATFORM", detail: PLATFORMS.join("|") };
  }
  if (!input.buf || input.buf.length === 0) {
    return { ok: false, status: 400, error: "EMPTY_FILE" };
  }

  const sha256 = sha256Buf(input.buf);
  const id = "rel_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dir = join(storageRoot(), version);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, input.filename);
  writeFileSync(filePath, input.buf);

  const chan: Channel = (CHANNELS as readonly string[]).includes(String(input.channel)) ? (input.channel as Channel) : "stable";

  try {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `INSERT INTO client_release
         (id, version, platform, arch, filename, "sizeBytes", sha256, state, channel, notes, "storagePath", "createdAt", "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10, (now() AT TIME ZONE 'UTC'), $11)
       RETURNING *`,
      id, version, input.platform, String(input.arch || "amd64"), input.filename,
      input.buf.length, sha256, chan, input.notes ?? null, filePath, input.createdBy ?? null
    );
    return { ok: true, row: rows[0] };
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    if (/duplicate key|unique/i.test(msg)) {
      return { ok: false, status: 409, error: "VERSION_EXISTS", detail: "同一 version+platform+arch 已存在" };
    }
    return { ok: false, status: 500, error: "INSERT_FAILED", detail: msg.slice(0, 200) };
  }
}

/**
 * 发布 = **签名 + 置 published**（R3，2026-10-29）
 *
 * 为什么在发布时签而不是上传时（老板/平台数据线的要求）：
 *   上传可能反复覆盖同一个版本号，签名必须发生在"确定要发布的那一刻"，否则签的可能是被替换掉的字节。
 *
 * 流程：读盘取**最终字节** → 重算 sha256 并与登记值比对（不一致即拒）→ 对同一份 Buffer 签名
 *      → 写 signature / signedBy(keyId) / state=published / publishedAt → 写审计事件。
 * 签名失败 → 保持原状态，返回 409/500，**绝不"先发布后补签"**。
 */
export async function publishRelease(
  id: string,
  channel: Channel,
  actor = "admin"
): Promise<{ ok: true; row: ClientReleaseRow } | { ok: false; status: number; error: string; detail?: string }> {
  const row = await getRelease(id);
  if (!row) return { ok: false, status: 404, error: "NOT_FOUND" };
  if (row.state === "revoked") return { ok: false, status: 409, error: "REVOKED_RELEASE" };

  const filePath = row.storagePath || "";
  if (!filePath || !existsSync(filePath)) return { ok: false, status: 410, error: "FILE_MISSING" };
  const buf = readFileSync(filePath);

  // 对**最终字节**校验：盘上内容必须与登记 sha256 一致，再签同一份 Buffer
  const actual = sha256Buf(buf);
  if (actual !== String(row.sha256)) {
    return { ok: false, status: 409, error: "CONTENT_CHANGED_SINCE_UPLOAD",
      detail: "盘上文件 sha256=" + actual.slice(0, 16) + " 与登记值不一致（上传后被改动？），拒绝签名" };
  }

  const signed = signBytes(buf);
  if ("error" in signed) {
    return { ok: false, status: 409, error: signed.error,
      detail: "服务端未配置签名密钥（run/client-keys/active），未签名不得发布" };
  }

  const rows: any[] = await (prisma as any).$queryRawUnsafe(
    `UPDATE client_release
        SET state='published', channel=$2, signature=$3, "signedBy"=$4,
            "signedAt"=(now() AT TIME ZONE 'UTC'),
            "keyFingerprint"=$5,
            "publishedAt"=(now() AT TIME ZONE 'UTC')
      WHERE id=$1 RETURNING *`,
    id, channel, signed.signature, signed.keyId, signed.fingerprint
  );

  // 审计：who / when / release_id / key_id（signed_by 存 key id，不是 "default"）
  await (prisma as any).flywheelEvent.create({
    data: {
      stage: "CLIENT_RELEASE_SIGNED",
      sourceType: "client_release",
      sourceId: id,
      sourceTitle: ("version=" + row.version + " platform=" + row.platform + "/" + row.arch +
        " key_id=" + signed.keyId + " fp=" + String(signed.fingerprint || "").slice(0, 16) + " by=" + actor).slice(0, 240),
      targetStage: "OK",
    },
  }).catch(() => null);

  return { ok: true, row: rows[0] };
}

export async function revokeRelease(id: string): Promise<{ ok: true; row: ClientReleaseRow } | { ok: false; status: number; error: string }> {
  const row = await getRelease(id);
  if (!row) return { ok: false, status: 404, error: "NOT_FOUND" };
  const rows: any[] = await (prisma as any).$queryRawUnsafe(
    `UPDATE client_release SET state='revoked', channel='internal', "publishedAt"=NULL WHERE id=$1 RETURNING *`, id
  );
  return { ok: true, row: rows[0] };
}

/** 下载：只允许 **latest**（设计 §5：portal 只提供最新） */
export async function openDownload(id: string): Promise<
  { ok: true; row: ClientReleaseRow; path: string } | { ok: false; status: number; error: string; detail?: string }
> {
  const row = await getRelease(id);
  if (!row) return { ok: false, status: 404, error: "NOT_FOUND" };
  if (row.state !== "published") return { ok: false, status: 409, error: "NOT_PUBLISHED" };
  const latest = await findLatest(row.platform, row.channel as Channel);
  if (!latest || latest.id !== row.id) {
    return { ok: false, status: 409, error: "NOT_LATEST", detail: "只提供最新版本下载，历史版本请从 console 打包记录获取" };
  }
  const p = row.storagePath || "";
  if (!p || !existsSync(p)) return { ok: false, status: 410, error: "FILE_MISSING" };
  await (prisma as any).$executeRawUnsafe(`UPDATE client_release SET "downloadCount"="downloadCount"+1 WHERE id=$1`, id).catch(() => null);
  return { ok: true, row, path: p };
}

export { createReadStream };
