import { NextResponse } from "next/server";
import { getActivityFeed } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getActivityFeed());
}
