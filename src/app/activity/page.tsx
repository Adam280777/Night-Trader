import { PageHeader } from "@/components/ui";
import { ActivityFeed } from "@/components/activity-feed";
import { getActivityFeed } from "@/lib/activity";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  // Rendered from the same payload the page then polls, so the first paint is never empty.
  return (
    <>
      <PageHeader
        title="Live activity"
        subtitle="What both strategy modules are doing now: overnight research, intraday scans, active positions, scheduling reasons, and every event as it happens."
      />
      <ActivityFeed initial={await getActivityFeed()} />
    </>
  );
}
