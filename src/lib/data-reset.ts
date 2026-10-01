import { eq, inArray, like, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import { resetRequiresKillSwitch, type DataResetTarget } from "./data-reset-config";

export interface DataResetResult {
  target: DataResetTarget;
  deleted: number;
  killSwitchEnabled: boolean;
}

export class UnsafeDataResetError extends Error {}

const affected = (result: { rowsAffected?: number }) => result.rowsAffected ?? 0;

/**
 * Delete generated bot data while preserving configuration, connection secrets and authentication.
 * The caller must hold the scheduler's global lease for the entire operation.
 */
export async function resetData(target: DataResetTarget): Promise<DataResetResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    if (target === "trading" || target === "all") {
      const openTrade = await tx.select({ id: schema.trades.id }).from(schema.trades).where(eq(schema.trades.status, "open")).limit(1);
      const unresolvedOrder = await tx
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(inArray(schema.orders.status, ["intent", "sent", "partial", "unknown"]))
        .limit(1);
      const activeExecution = await tx
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(inArray(schema.runs.status, ["executing", "holding", "exiting"]))
        .limit(1);
      if (openTrade.length || unresolvedOrder.length || activeExecution.length) {
        throw new UnsafeDataResetError("Trading data cannot be deleted while a position, execution, or unresolved broker order exists.");
      }
    }

    let deleted = 0;
    if (target === "logs" || target === "all") {
      deleted += affected(await tx.delete(schema.eventLog));
      deleted += affected(await tx.delete(schema.jobRuns));
      deleted += affected(await tx.delete(schema.equitySnapshots));
      if (target !== "all") {
        deleted += affected(
          await tx.delete(schema.kv).where(or(
            like(schema.kv.key, "warn:%"),
            like(schema.kv.key, "alert:%"),
            like(schema.kv.key, "jobfail:%"),
            eq(schema.kv.key, "t:equity"),
          )),
        );
      }
    }

    if (target === "research" || target === "trading" || target === "all") {
      deleted += affected(await tx.delete(schema.lessons));
    }
    if (target === "research" || target === "all") {
      deleted += affected(await tx.delete(schema.modelState));
      deleted += affected(await tx.delete(schema.knowledge));
      deleted += affected(await tx.delete(schema.studySkips));
      if (target !== "all") {
        deleted += affected(
          await tx.delete(schema.kv).where(or(
            like(schema.kv.key, "study:%"),
            like(schema.kv.key, "backfill:%"),
            like(schema.kv.key, "mctx:%"),
            inArray(schema.kv.key, ["t:study", "t:backfill", "t:learning", "t:outcomes"]),
          )),
        );
      }
    }
    if (target === "trading" || target === "all") {
      deleted += affected(await tx.delete(schema.orders));
      deleted += affected(await tx.delete(schema.trades));
      deleted += affected(await tx.delete(schema.candidates));
      deleted += affected(await tx.delete(schema.decisions));
      deleted += affected(await tx.delete(schema.runs));
      if (target !== "all") {
        deleted += affected(
          await tx.delete(schema.kv).where(or(
            like(schema.kv.key, "ensure:%"),
            like(schema.kv.key, "intraday:%"),
            like(schema.kv.key, "t:intraday-scan:%"),
          )),
        );
      }
    }
    if (target === "all") {
      deleted += affected(await tx.delete(schema.chatMessages));
      deleted += affected(await tx.delete(schema.kv));
      deleted += affected(
        await tx.delete(schema.settings).where(inArray(schema.settings.key, ["_heartbeat"])),
      );
    }

    const killSwitchEnabled = resetRequiresKillSwitch(target);
    if (killSwitchEnabled) {
      await tx
        .insert(schema.settings)
        .values({ key: "killSwitch", value: true })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: true } });
    }

    return { target, deleted, killSwitchEnabled };
  });
}
