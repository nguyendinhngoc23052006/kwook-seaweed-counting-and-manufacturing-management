import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { ListRow, ListRows } from "../../components/ui/ListRow";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { Select } from "../../components/ui/Select";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { rankLabel } from "../../lib/orgLabels";
import { getMyCapabilityReach } from "../../services/capabilities";
import {
  createRank,
  listAllRanks,
  ordinalBetween,
  type Rank,
  updateRank,
} from "../../services/ranks";

// The ladder, and the page that lets it grow.
//
// ranks_admin_insert and ranks_admin_update have existed since org_foundation,
// and org_foundation's own seed comment describes somebody "using the
// documented workflow to insert their own rank" -- but the app could only ever
// read the five seeded rungs, so the hierarchy was exactly five deep forever.
//
// A new rung is placed by naming its two neighbours, never by typing an
// ordinal: the seeded gaps of 1000 are what make room, and a human should not
// have to know that.
export function RanksPage(): JSX.Element {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [nameVi, setNameVi] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [aboveKey, setAboveKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reach = useQuery({ queryKey: ["org", "reach"], queryFn: getMyCapabilityReach });
  const isAdmin = reach.data?.isAdmin === true;

  const ranks = useQuery({
    queryKey: ["org", "all-ranks"],
    queryFn: listAllRanks,
    enabled: isAdmin,
  });

  const rows = ranks.data ?? [];
  const active = rows.filter((r) => r.active);

  const refresh = () => {
    setError(null);
    queryClient.invalidateQueries({ queryKey: ["org", "all-ranks"] });
    queryClient.invalidateQueries({ queryKey: ["org", "ranks"] });
  };

  // "Below X" is the only placement a human states. The ordinal is derived
  // from X and whatever currently sits under it.
  const ordinalForNew = (): number => {
    if (active.length === 0) return ordinalBetween(null, null);
    if (aboveKey === "") {
      const first = active[0];
      return ordinalBetween(null, first ? first.ordinal : null);
    }
    const index = active.findIndex((r) => r.key === aboveKey);
    const above = active[index];
    const below = active[index + 1];
    return ordinalBetween(above ? above.ordinal : null, below ? below.ordinal : null);
  };

  const create = useMutation({
    mutationFn: () => createRank({ key, nameVi, nameEn, ordinal: ordinalForNew() }),
    onSuccess: () => {
      setKey("");
      setNameVi("");
      setNameEn("");
      refresh();
    },
    onError: (e) => setError(errorMessage(e, t("ranks.create_failed"))),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      updateRank(input.id, { active: input.active }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("ranks.update_failed"))),
  });

  if (reach.isLoading) return <ListSkeleton rows={3} label={t("common.loading")} />;
  if (!isAdmin) return <ErrorState message={t("common.access_denied")} />;
  if (ranks.isError) {
    return <ErrorState message={errorMessage(ranks.error, t("ranks.load_failed"))} />;
  }

  // A key must be new and url-ish: it is the string every policy and report
  // compares against, so it is chosen once and never re-keyed (updateRank
  // deliberately has no key field).
  const keyOk =
    /^[a-z][a-z0-9_]{1,30}$/.test(key.trim()) && !rows.some((r) => r.key === key.trim());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-foreground">{t("ranks.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("ranks.subtitle")}</p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Section title={t("ranks.ladder")} description={t("ranks.ladder_hint")}>
        {ranks.isLoading ? (
          <ListSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <Empty title={t("ranks.empty")} />
        ) : (
          <ListRows>
            {rows.map((rank: Rank) => (
              <ListRow
                key={rank.id}
                title={rankLabel(rank, locale)}
                subtitle={rank.key}
                meta={!rank.active ? <Pill tone="neutral">{t("ranks.retired")}</Pill> : undefined}
                trailing={
                  <Button
                    size="sm"
                    variant={rank.active ? "ghost" : "secondary"}
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: rank.id, active: !rank.active })}
                  >
                    {rank.active ? t("ranks.retire") : t("ranks.restore")}
                  </Button>
                }
              />
            ))}
          </ListRows>
        )}
        <p className="pb-2 pt-3 text-xs text-muted-foreground">{t("ranks.retire_hint")}</p>
      </Section>

      <Section title={t("ranks.add")} description={t("ranks.add_hint")}>
        <div className="space-y-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="rank-name-vi">{t("ranks.name_vi")}</Label>
              <Input
                id="rank-name-vi"
                value={nameVi}
                onChange={(e) => setNameVi(e.target.value)}
                disabled={create.isPending}
              />
            </div>
            <div>
              <Label htmlFor="rank-name-en">{t("ranks.name_en")}</Label>
              <Input
                id="rank-name-en"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                disabled={create.isPending}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="rank-key">{t("ranks.key")}</Label>
            <Input
              id="rank-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="team_lead"
              disabled={create.isPending}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("ranks.key_hint")}</p>
            {key.trim() !== "" && !keyOk && (
              <p className="mt-1 text-xs text-danger-text">{t("ranks.key_bad")}</p>
            )}
          </div>

          <div>
            <Label htmlFor="rank-above">{t("ranks.place")}</Label>
            <Select
              id="rank-above"
              value={aboveKey}
              onChange={setAboveKey}
              ariaLabel={t("ranks.place")}
              disabled={create.isPending}
              options={[
                { value: "", label: t("ranks.place_top") },
                ...active.map((r) => ({
                  value: r.key,
                  label: t("ranks.place_below", { rank: rankLabel(r, locale) }),
                })),
              ]}
            />
          </div>

          <div className="flex justify-end">
            <Button
              disabled={create.isPending || !keyOk || !nameVi.trim()}
              onClick={() => create.mutate()}
            >
              {create.isPending ? t("common.loading") : t("ranks.add_submit")}
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}
