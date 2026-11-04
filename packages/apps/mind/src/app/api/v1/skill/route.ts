import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-08 round 54: category 受控投影
import { projectCategory } from "../../../../server/pipeline/enum-projection";
// 2026-10-08 round 58: 标题归一 (Prisma 拦截器 + 4 store 已铺, API 端归一作为兜底)
// 2026-10-08 round 61: 写端 dedup(同义 Skill 防再生) - API 端用事务做, 拦截器作为非 API 路径的兜底
// 2026-10-09 round 70: 技能名走**专用**归一(永不含省略号; 不做有损截断)
import { normalizeSkillName, SKILL_NAME_MAX, SKILL_SUMMARY_MAX } from "@lions/product-contract";
// 2026-10-09 round 68: Skill 写入的唯一去重入口(归一 + 撞名策略)
import { writeSkillDeduped } from "../../../../server/pipeline/skill-dedup";
// 2026-10-25 R4: 归属过滤（列存在才生效；运行时探测前置，窗口前行为不变）
import { readableWhere } from "../../../../server/pipeline/asset-scope";
import { resolveRequestActor } from "../../../../server/lib/request-actor";
import { hasAssetColumns } from "../../../../server/lib/asset-columns";

// ===== SKILL-SPEC 2026-08-28 (docs/SKILL-SPEC.md) =====
// GET  /api/v1/skill - 技能列表 (agent/前端用)
//   参数: search, category, legacy(false=默认只看新规范), stale, page, pageSize
// POST /api/v1/skill - 创建技能 (7 字段校验, 无 steps 不成 skill)

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const params = url.searchParams;

  const where: any = {};
  if (params.get("legacy") !== "true") where.legacy = false; // 默认只看符合新规范的
  if (params.get("stale") === "false") where.stale = false;  // stale=true/缺省 = 不过滤 (含 stale)
  if (params.get("category")) where.category = params.get("category");
  if (params.get("search")) {
    const q = params.get("search")!;
    // 2026-10-09 round 70: 名称/摘要/标签是**初筛层**(人类口径: 靠这三样判断要不要展开看详情),
    //   所以检索必须覆盖它们; steps/content 仍可搜, 但那是"已经确定要看详情"之后的路径。
    where.OR = [
      { name: { contains: q } },
      { summary: { contains: q } },
      { tags: { contains: q } },
      { trigger: { contains: q } },
      { description: { contains: q } },
      { content: { contains: q } },
    ];
  }

  // 2026-10-25 R4: 归属过滤（Skill 列待窗口；探测 false 时不附加）
  let meta: any = { scope: "off" };
  if (await hasAssetColumns("skill")) {
    const who = await resolveRequestActor(req);
    if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
    const scope = readableWhere(who.actor, { kind: "skill" });
    if (Object.keys(scope).length) {
      where.AND = [...(where.AND ?? []), scope];
      meta = { scope: "enforced", admin: String(who.actor?.role || "").toUpperCase() === "ADMIN" || String(who.actor?.role || "").toUpperCase() === "OWNER" };
    }
  }

  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const pageSize = Math.min(parseInt(params.get("pageSize") || "20"), 100);

  const [items, total] = await Promise.all([
    prisma.skill.findMany({
      where,
      orderBy: [{ qualityScore: "desc" }, { totalUsageCount: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      // 2026-10-09 round 70: 列表层返回 名称/摘要/标签 三件套(+分类/级别/质量分) ——
      //   刻意**不含 content(steps)**: 详情层才展开, 避免列表把上下文撑爆。
      select: {
        id: true, name: true, summary: true, tags: true, category: true, level: true,
        description: true,
        trigger: true, verification: true, pitfalls: true, platforms: true,
        version: true, totalUsageCount: true,
        qualityScore: true, stale: true, legacy: true,
        createdAt: true, updatedAt: true,
      },
    }),
    prisma.skill.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize, meta });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // 7 字段校验
  const nameRaw = (body.name || "").trim();
  const steps = (body.steps ?? body.content ?? "").trim();
  const trigger = (body.trigger || "").trim();
  const verification = (body.verification || "").trim();

  if (!nameRaw) return NextResponse.json({ error: "name 必填 (中文动宾短语, 如 '端口占用诊断')" }, { status: 400 });
  if (steps.length < 30)
    return NextResponse.json(
      { error: "steps 必填且 ≥30 字 (SKILL-SPEC 铁律: 无 steps 不成 skill)。steps=markdown 编号步骤, 每步含可执行命令/路径/参数" },
      { status: 400 }
    );
  if (!trigger) return NextResponse.json({ error: "trigger 必填 (适用场景: 什么时候用)" }, { status: 400 });
  if (!verification) return NextResponse.json({ error: "verification 必填 (验证方法: 怎么确认成功)" }, { status: 400 });

  // 2026-10-09 round 70: 技能名归一 —— **不接受有损截断**(人类口径: 名称要简写、不能有省略)。
  //   归一后仍 >20 字 -> 明确 400 让调用方给语义简写, 而不是硬砍成一个可能与别的技能撞名的短名。
  //   为什么不能硬砍: 实测 'Prisma schema设计与migration' / 'Prisma ORM与DateTime处理' / 'Prisma $queryRawUnsafe'
  //   头部截断后**全变成 "Prisma"** —— 而写端判据是"同名即同技能", 会把这些不同技能合并掉。
  const name = normalizeSkillName(nameRaw, { max: SKILL_NAME_MAX }) || nameRaw;
  if (name.length > SKILL_NAME_MAX) {
    return NextResponse.json(
      {
        error: "NAME_TOO_LONG",
        message: "name 归一后仍为 " + name.length + " 字(上限 " + SKILL_NAME_MAX + ")。请给**语义简写**" +
          "(如 'Prisma schema设计与迁移'), 不接受省略号截断 —— 截断会与其它技能撞名并被误判为同一技能。",
        normalized: name,
      },
      { status: 400 },
    );
  }

  // 2026-10-09 round 68: 去重实现**收敛到 writeSkillDeduped 单一来源** —— 本路由原先自己写了一份
  //   retire+create+supersede 事务(round 61), 而 pipeline 的 6+ 个写点各写各的、多数连归一都没有,
  //   于是"API 端去重了"给人"已经治好了"的错觉(实测 859 条超长/同义名 829 条来自 LEARNED 直连写)。
  //   路由语义是"人类/agent 明确提交新技能" -> new-wins(旧行让位, 新行作主条), 与原行为一致。
  //   仍包在 prisma.$transaction 里: 让 retire+create+supersede 与后续写入同一原子单元。
  //   (round 61 的教训仍然成立: 这件事**不能**放进 Prisma 拦截器 —— 拦截器里嵌事务会 P2028 超时,
  //    且步骤 A 已写盘留脏行; hook 层只放纯函数。)
  const { skill } = await prisma.$transaction(async (tx) => {
    return await writeSkillDeduped(tx, {
      name,
      description: (body.description || name).trim(),
      content: steps,
      trigger,
      verification,
      pitfalls: (body.pitfalls || "").trim() || null,
      platforms: (body.platforms || "").trim() || null,
      category: projectCategory(body.category, "skill") ?? "OTHER",
      version: 1,
      qualityScore: Math.min(0.9, 0.5 + Math.min(steps.length, 2000) / 4000),
      source: "IMPORTED",
      // 2026-10-09 round 70: 摘要/标签(可空; 归一由 writeSkillDeduped 内部统一做)
      summary: body.summary ?? null,
      tags: body.tags ?? null,
    }, { onConflict: "new-wins", actor: "api:v1:skill" });
  });

  return NextResponse.json({ ok: true, skill }, { status: 201 });
}
