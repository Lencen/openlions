import { NextResponse } from "next/server";
import { getAllTasks } from "@/lib/tasks-source";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tasks = getAllTasks();
    return NextResponse.json({ success: true, count: tasks.length, tasks });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
