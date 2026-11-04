import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

function genCuid(): string {
  return "c" + crypto.randomBytes(12).toString("hex") + Date.now().toString(36);
}

const inputSchema = z.preprocess(
  (val: any) => (val && typeof val === "object" && "json" in val ? val.json : val),
  z.object({
    agentId: z.string().min(1),
    sourceService: z.string().min(1),
    sourceRef: z.string().optional(),
    problem: z.string().min(1),
    context: z.string().optional(),
    impact: z.string().optional(),
    suggestedImprovement: z.string().optional(),
    severity: z.string().default("P2"),
    createTaskPolicy: z.enum(["NEVER", "AUTO_IF_ACTIONABLE", "ALWAYS"]).default("AUTO_IF_ACTIONABLE"),
    payload: z.record(z.string(), z.any()).optional(),
    idempotencyKey: z.string().optional(),
  })
);

export const reflectionIngestRouter = createRouter({
  ingest: publicProcedure.input(inputSchema).mutation(async ({ input }) => {
    const now = new Date().toISOString();
    const evidenceKey = input.idempotencyKey ?? `reflection:${input.sourceService}:${input.sourceRef ?? crypto.createHash("sha256").update(input.problem).digest("hex")}`;
    const payload = JSON.stringify({
      problem: input.problem,
      context: input.context ?? null,
      impact: input.impact ?? null,
      suggestedImprovement: input.suggestedImprovement ?? null,
      severity: input.severity,
      createTaskPolicy: input.createTaskPolicy,
      payload: input.payload ?? null,
    });
    const evidenceId = genCuid();
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO Evidence
       (id, sourceType, sourceService, agentId, sourceId, title, summary, payload, idempotencyKey, status, createdAt, updatedAt)
       VALUES (?, 'REFLECTION_INGEST', ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)`,
      evidenceId,
      input.sourceService,
      input.agentId,
      input.sourceRef ?? null,
      input.problem.slice(0, 200),
      input.context ?? input.problem,
      payload,
      evidenceKey,
      now,
      now
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM Evidence WHERE idempotencyKey = ? LIMIT 1`, evidenceKey
    );
    const finalEvidenceId = rows[0]?.id ?? evidenceId;
    const jobKey = `job:REFLECTION_ANALYZE:${evidenceKey}`;
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO FlywheelJob
       (id, jobType, status, evidenceId, sessionUid, agentId, priority, attempts, maxAttempts, error, idempotencyKey, scheduledAt, createdAt, updatedAt)
       VALUES (?, 'REFLECTION_ANALYZE', 'PENDING', ?, NULL, ?, ?, 0, 3, NULL, ?, ?, ?, ?)`,
      genCuid(), finalEvidenceId, input.agentId, input.severity, jobKey, now, now, now
    );
    const jobRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM FlywheelJob WHERE idempotencyKey = ? LIMIT 1`, jobKey
    );
    return { ok: true, evidenceId: finalEvidenceId, jobId: jobRows[0]?.id ?? null };
  }),
});
