/**
 * safe-create.ts -- mind 端**统一写入包装层** (2026-10-08 round 56b)
 *
 * 为什么需要: 33 个 qualityScore 缺口里 ~20 个是 routers 直接 prisma.*.create, 不走 module store
 *   (store 闸在 round 55+56a 只能覆盖走 store 的 ~13 个). 本文件提供 mind 端的 safeCreateX 三件套:
 *
 *   safeCreateKnowledge(prisma, data)  ->  PrismaKnowledgeStore(prisma).create(data)
 *   safeCreatePractice(prisma, data)    ->  PrismaPracticeStore(prisma).create(data)
 *   safeCreateMemory(prisma, data)      ->  PrismaMemoryStore(prisma).create(data)
 *
 * store 内部已经做了 category/domain/outcome/type 受控投影 + qualityScore 兜底 (round 55 + 56a);
 *   本 wrapper **不重复**这些(避免漂移), 只做一个事: 给 mind 端一个**带守卫**的统一出口.
 *
 * 配套守门: scripts/check-prisma-direct-creates.cjs (静态扫描) + scripts/prisma-direct-creates-baseline.json
 *   (登记 20 个现有 routers 直写站为 grandfathered; 新增直写即红).
 *
 * 何时该用 safeCreateX:
 *   - routers/learning.ts, knowledge.ts, memory.ts, reflection.ts, skill.ts, practice.ts, agent.ts, flywheel.ts
 *     未来新增的写入代码 (round 57+ 迁移后, 旧站 grandfathered 不再需要)
 *   - 新建写入路径(比如新 API、新管道)默认走 safeCreateX 而不是直接 prisma.*.create
 *
 * 见 docs/platform-logic/round56b-safe-create-and-write-gate-8dim-review-2026-10-08.md.
  */
import type { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import { PrismaMemoryStore } from "@lions/modules-memory";
import { PrismaKnowledgeStore } from "@lions/modules-knowledge";
import { PrismaPracticeStore } from "@lions/modules-practice";
import { PrismaReflectionStore } from "@lions/modules-reflection";
import { PrismaSkillStore } from "@lions/modules-skill";

/**
 * 参数形态刻意与 Prisma 保持一致: 调用方传 `{ data: {...} }`(也可与 select 混用), 于是**迁移 = 纯文本替换**:
 *   `prisma.knowledge.create(` -> `safeCreateKnowledge(prisma, ` —— 不改缩进、不动花括号.
 *   (实测教训: 若改参数形态, 每站都要做结构手术, 风险与工作量都翻倍.) 兼容 `{ data }` 与裸 data 两种写法.
 */
function unwrap(args: any): any {
  if (args && typeof args === "object" && Object.prototype.hasOwnProperty.call(args, "data")) return args.data;
  return args;
}

// 重用 store 闸 (内部已做受控投影 + qualityScore 兜底); mind 特有的检查(StaleReason 模板等)由调用方传入前完成.
export async function safeCreateMemory(prisma: PrismaClient, args: any): Promise<any> {
  return new PrismaMemoryStore(prisma).create(unwrap(args));
}

export async function safeCreateKnowledge(prisma: PrismaClient, args: any): Promise<any> {
  return new PrismaKnowledgeStore(prisma).create(unwrap(args));
}

export async function safeCreatePractice(prisma: PrismaClient, args: any): Promise<any> {
  return new PrismaPracticeStore(prisma).create(unwrap(args));
}

export async function safeCreateReflection(prisma: PrismaClient, args: any): Promise<any> {
  return new PrismaReflectionStore(prisma).create(unwrap(args));
}

export async function safeCreateSkill(prisma: PrismaClient, args: any): Promise<any> {
  return new PrismaSkillStore(prisma).create(unwrap(args));
}
