import { PageHeader } from "@/components/ui";
import { LogViewer } from "@/components/log-viewer";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Every event the scheduler, study loop, pipeline and broker calls have written. Search, filter by level, source, run or time, scroll back through history, and download the matching lines as a CSV."
      />
      <LogViewer />
    </>
  );
}
