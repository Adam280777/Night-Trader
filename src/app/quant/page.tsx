import { PageHeader } from "@/components/ui";
import { QuantForm } from "@/components/quant-form";
import { getSettingsView } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function QuantPage() {
  const { settings } = await getSettingsView();
  return (
    <>
      <PageHeader
        title="Quant settings"
        subtitle="Every number the decision engine uses, grouped by what it affects, each one saying what moving it does. Changes save instantly and apply to the next run, so nothing already in flight is touched — and none of them can override the safety limits in Settings."
      />
      <QuantForm settings={settings} />
    </>
  );
}
