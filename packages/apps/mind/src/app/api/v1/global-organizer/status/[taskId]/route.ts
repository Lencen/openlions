import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/server/pipeline/global-organizer";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { taskId: string } },
) {
  const task = await getTask(params.taskId);

  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  return NextResponse.json({
    taskId: task.taskId,
    groupKey: task.groupKey,
    status: task.status,
    duration: task.duration,
    products: task.products,
    calibration: task.calibration,
    skills: task.skills,
    stalePropagated: task.stalePropagated,
    error: task.error,
  });
}
