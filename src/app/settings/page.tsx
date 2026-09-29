import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { ConnectionsForm, PasswordForm } from "@/components/connections-form";
import { connectionStatus } from "@/lib/connections";
import { getSettingsView } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const { settings, env } = getSettingsView();
  return (
    <>
      <PageHeader title="Settings" subtitle="Connect your accounts, tune the safety limits and manage access. Changes save instantly." />
      <div className="space-y-6">
        <ConnectionsForm initial={connectionStatus()} />
        <SettingsForm settings={settings} t212Env={env.t212Env} hasT212Keys={env.hasT212Keys} hasOpenAI={env.hasOpenAI} />
        <PasswordForm />
      </div>
    </>
  );
}
