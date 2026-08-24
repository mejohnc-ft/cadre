import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { usageQueryOptions } from "@/lib/models/queries";

export const Route = createFileRoute("/_authed/admin/usage")({
  component: UsagePage,
});

function UsagePage() {
  const usage = useQuery(usageQueryOptions());
  const nameFor = useBotNames();
  const rows = usage.data?.usage ?? [];
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <PageShell
      description={`Spend and run counts per coworker, over the last ${usage.data?.days ?? 30} days, from what each run reported. Reported cost is available for harness coworkers; a built-in Bot's model cost is not itemised here.`}
      title="Usage"
    >
      <PageSection title={`Coworkers · $${totalCost.toFixed(2)} total`}>
        {rows.length === 0 ? (
          <PageEmpty>Nothing to report yet.</PageEmpty>
        ) : (
          <PageRows>
            {rows.map((row, index) => (
              <div key={row.agentId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{nameFor(row.agentId)}</ItemTitle>
                    <ItemDescription>
                      {row.runs} run{row.runs === 1 ? "" : "s"}
                      {row.costUsd > 0 ? ` · $${row.costUsd.toFixed(4)}` : ""}
                      {row.durationMs > 0
                        ? ` · ${(row.durationMs / 1000).toFixed(1)}s of model time`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
