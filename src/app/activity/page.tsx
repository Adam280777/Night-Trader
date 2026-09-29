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
        subtitle="What the model is doing right now — what it is studying, what it has shortlisted, how far tonight's run has got, and every event as it happens. Refreshes every few seconds."
      />
      <ActivityFeed initial={await getActivityFeed()} />
    </>
  );
}
