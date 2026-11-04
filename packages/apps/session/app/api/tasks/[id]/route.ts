import { NextResponse } from "next/server";
import { getTaskById, getExecutionRecords, getCronSessionRecordsAsync, type ExecutionRecord } from "@/lib/tasks-source";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const task = getTaskById(params.id);
    if (!task) return NextResponse.json({ success: false, error: "task not found" }, { status: 404 });
    // 执行记录: 优先 cron session messages, 兜底 log file
    // 2026-10-14: 显式标注类型 —— 原先 `let records = []` 在 noImplicitAny 下推不出数组元素类型 (TS7034/7005)。
    //   两个生产者 (getCronSessionRecordsAsync / getExecutionRecords) 的返回类型本来就是 ExecutionRecord[],
    //   所以这里只是把既有事实写出来, 无任何运行期影响 (类型在编译后被擦除)。
    let records: ExecutionRecord[] = [];
    if (task.sessionKey) {
      records = await getCronSessionRecordsAsync(task.sessionKey, 20);
    }
    if (records.length === 0) {
      records = getExecutionRecords(task, 20);
    }
    return NextResponse.json({ success: true, task, records });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
