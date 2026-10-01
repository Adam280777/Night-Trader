import { NextResponse } from "next/server";
import { z } from "zod";
import { resetData, UnsafeDataResetError } from "@/lib/data-reset";
import { DATA_RESET_CONFIRMATIONS, DATA_RESET_TARGETS } from "@/lib/data-reset-config";
import { withLock } from "@/lib/locks";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  target: z.enum(DATA_RESET_TARGETS),
  confirmText: z.string(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid reset request." }, { status: 400 });

  const { target, confirmText } = parsed.data;
  const phrase = DATA_RESET_CONFIRMATIONS[target];
  if (confirmText !== phrase) {
    return NextResponse.json({ error: `Type ${phrase} exactly to confirm.` }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof resetData>> | null = null;
  let resetError: unknown;
  const acquired = await withLock("tick", 120_000, async () => {
    try {
      result = await resetData(target);
    } catch (error) {
      resetError = error;
    }
  });
  if (!acquired) {
    return NextResponse.json({ error: "The scheduler is currently working. Wait for the current tick to finish, then try again." }, { status: 409 });
  }
  if (resetError instanceof UnsafeDataResetError) {
    return NextResponse.json({ error: resetError.message }, { status: 409 });
  }
  if (resetError) throw resetError;
  if (!result) throw new Error("The reset completed without a result.");

  return NextResponse.json(result);
}
