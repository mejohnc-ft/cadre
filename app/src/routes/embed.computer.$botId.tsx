import { createFileRoute } from "@tanstack/react-router";
import { ComputerView } from "@/components/computer/computer-view";

/**
 * A full-bleed live screen for one coworker, with no admin chrome, meant to be embedded in an
 * iframe by another app (the Service Toolbox investigation panel). It carries the same take-control
 * and secret-prompt affordances as the admin computer view, so a person watching the agent work can
 * step in. Public route — on a loopback single-user deployment the computer endpoints already answer
 * as the local admin; a networked deployment would gate this with an embed token.
 */
export const Route = createFileRoute("/embed/computer/$botId")({
  component: EmbeddedComputer,
});

function EmbeddedComputer() {
  const { botId } = Route.useParams();
  return (
    <div className="min-h-screen w-full bg-background p-2">
      <ComputerView computerId={botId} intervalMs={800} />
    </div>
  );
}
