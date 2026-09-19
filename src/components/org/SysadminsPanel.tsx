import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { appointSysadmin, listSysadmins, retireSysadmin } from "../../services/sysadmins";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Input, Label } from "../ui/Input";
import { ListRow, ListRows } from "../ui/ListRow";
import { Section } from "../ui/Section";
import { ListSkeleton } from "../ui/Skeleton";

// Handing over the keys. The database refuses to let the last one leave --
// a model with no sitting sysadmin is inert forever -- so the successor is
// appointed first and the button says so rather than failing.
export function SysadminsPanel(): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sysadmins = useQuery({ queryKey: ["org", "sysadmins"], queryFn: listSysadmins });

  const refresh = () => {
    setError(null);
    setEmail("");
    queryClient.invalidateQueries({ queryKey: ["org", "sysadmins"] });
    queryClient.invalidateQueries({ queryKey: ["org", "reach"] });
  };

  const appoint = useMutation({
    mutationFn: () => appointSysadmin(email),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("sysadmins.appoint_failed"))),
  });

  const retire = useMutation({
    mutationFn: (accountId: string) => retireSysadmin(accountId),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("sysadmins.retire_failed"))),
  });

  const rows = sysadmins.data ?? [];
  const isLast = rows.length <= 1;

  return (
    <Section title={t("sysadmins.title")} description={t("sysadmins.hint")}>
      <div className="space-y-4 py-2">
        {error && <Alert variant="error">{error}</Alert>}

        {sysadmins.isLoading ? (
          <ListSkeleton rows={2} />
        ) : (
          <ListRows>
            {rows.map((s) => (
              <ListRow
                key={s.account_id}
                title={s.email}
                subtitle={t("sysadmins.since", {
                  date: new Date(s.since).toLocaleDateString(),
                })}
                trailing={
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={retire.isPending || isLast}
                    onClick={() => retire.mutate(s.account_id)}
                  >
                    {t("sysadmins.retire")}
                  </Button>
                }
              />
            ))}
          </ListRows>
        )}

        {isLast && <Alert variant="warning">{t("sysadmins.last_one")}</Alert>}

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <div className="min-w-56 flex-1">
            <Label htmlFor="sysadmin-email">{t("sysadmins.email")}</Label>
            <Input
              id="sysadmin-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
              disabled={appoint.isPending}
            />
          </div>
          <Button disabled={appoint.isPending || !email.trim()} onClick={() => appoint.mutate()}>
            {appoint.isPending ? t("common.loading") : t("sysadmins.appoint")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("sysadmins.email_hint")}</p>
      </div>
    </Section>
  );
}
