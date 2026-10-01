"use client";

import { Histogram } from "@/components/viz/Histogram";
import { TimeSeriesChart } from "@/components/viz/TimeSeriesChart";

export function ReturnHistogram({ values }: { values: (number | null)[] }) {
  return <Histogram values={values} format={(value) => `${value.toFixed(1)}%`} countLabel="Trades" ariaLabel="Distribution of closed trade returns" />;
}

export function JobDurationChart({ jobs, slowSeconds }: { jobs: { ts: number; seconds: number }[]; slowSeconds: number }) {
  return (
    <TimeSeriesChart
      data={jobs.map((job) => ({ x: job.ts, seconds: job.seconds }))}
      series={[{ key: "seconds", name: "Duration", kind: "line", tone: "info" }]}
      formatValue={(value) => `${value.toFixed(1)}s`}
      referenceLines={[{ y: slowSeconds, label: "slow warning", tone: "warn" }]}
      ariaLabel="Background job duration over time"
    />
  );
}
