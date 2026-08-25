import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ComputerView } from "@/components/computer/computer-view";

/**
 * A full-bleed live screen for one coworker, embedded by another app (the Service Toolbox
 * investigation panel). A desktop-image computer answers noVNC — a real, interactive desktop with a
 * working clipboard — and we iframe that. A headless computer has no noVNC, so we fall back to the
 * screenshot-based ComputerView. Public route; a networked deployment would gate it with a token.
 */
export const Route = createFileRoute("/embed/computer/$botId")({
  component: EmbeddedComputer,
});

function EmbeddedComputer() {
  const { botId } = Route.useParams();
  const [novnc, setNovnc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const response = await fetch(
          `/api/computers/${encodeURIComponent(botId)}/novnc`,
        );
        const body = (await response.json()) as { novnc: string | null };
        if (live) setNovnc(body.novnc ?? null);
      } catch {
        if (live) setNovnc(null);
      }
    };
    void check();
    // The VM (and its IP) may still be starting; re-check for a while until noVNC appears.
    const timer = setInterval(check, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [botId]);

  if (novnc) {
    return (
      <iframe
        allow="clipboard-read; clipboard-write"
        className="h-screen w-screen border-0"
        src={novnc}
        title={`${botId} desktop`}
      />
    );
  }

  return (
    <div className="min-h-screen w-full bg-background p-2">
      <ComputerView computerId={botId} intervalMs={800} />
    </div>
  );
}
