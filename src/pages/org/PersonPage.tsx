import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FaceEnrollmentPanel } from "../../components/org/FaceEnrollmentPanel";
import {
  bankPatchOf,
  emptyPersonDraft,
  PersonDetailsFields,
  type PersonDraft,
  profilePatchOf,
} from "../../components/org/PersonDetailsFields";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Label } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { Select } from "../../components/ui/Select";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import {
  attachAccount,
  getPerson,
  getPersonBankDetails,
  listUnattachedAccounts,
  savePersonBankDetails,
  setPersonStatus,
  updatePersonProfile,
} from "../../services/people";

// The other half of "the manager maintains their crew". The doorways create a
// person; this is where their name, photo and bank details are corrected
// afterwards, which is most of the actual work once a team exists.
//
// The node is in the URL rather than looked up, because capability is granted
// per node and the caller arrived from one — resolving it again would be a
// second answer to a question the route already answered.
export function PersonPage(): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const { nodeId, personId } = useParams<{
    nodeId: string;
    personId: string;
  }>();
  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [chosenAccount, setChosenAccount] = useState("");

  const person = useQuery({
    queryKey: ["org", "person", personId],
    queryFn: () => getPerson(personId as string),
    enabled: !!personId,
  });

  const bank = useQuery({
    queryKey: ["org", "person-bank", personId],
    queryFn: () => getPersonBankDetails(personId as string),
    enabled: !!personId,
  });

  const myReach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });

  // Prefill once both reads land. Bank details come back null when the caller
  // may not read them, which is a real answer rather than an error, so the
  // section simply stays empty.
  useEffect(() => {
    const p = person.data;
    if (!p) return;
    const b = bank.data;
    setDraft({
      fullName: p.full_name ?? "",
      phone: p.phone ?? "",
      email: p.email ?? "",
      hireDate: p.hire_date ?? "",
      photoUrl: p.photo_url ?? "",
      dateOfBirth: p.date_of_birth ?? "",
      nationalId: p.national_id ?? "",
      address: p.address ?? "",
      bankName: b?.bank_name ?? "",
      accountHolder: b?.account_holder ?? "",
      accountNumber: b?.account_number ?? "",
      branch: b?.branch ?? "",
    });
  }, [person.data, bank.data]);

  const canMaintainProfile = capabilityReaches(
    myReach.data,
    "maintain_person_profile",
    nodeId ?? "",
  );
  const canMaintainBank = capabilityReaches(myReach.data, "maintain_bank_details", nodeId ?? "");
  const isSelf = myReach.data?.personId === personId;
  const canEditProfile = canMaintainProfile || isSelf;
  // enroll_own_face is a privilege, not a default: a coworker with camera
  // access must not be able to enrol someone else's face as their own.
  const canSelfEnroll =
    myReach.data?.isAdmin === true || (myReach.data?.byKey.enroll_own_face?.length ?? 0) > 0;

  // Offboarding is what actually removes authority: since 20260928000000 a
  // non-active holder's seats confer nothing. The row, the seat and every hour
  // worked survive, so coming back is one click, not a re-hire.
  const changeStatus = useMutation({
    mutationFn: (status: "active" | "suspended" | "departed") =>
      setPersonStatus(personId as string, status),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["org", "person", personId] });
      queryClient.invalidateQueries({ queryKey: ["org", "tree"] });
      queryClient.invalidateQueries({ queryKey: ["org", "reach"] });
    },
    onError: (e) => setError(errorMessage(e, t("person_page.status_failed"))),
  });

  // The link the app never had: a person and a login were two records nothing
  // joined, so the only way to give somebody access was to edit the database.
  const detach = useMutation({
    mutationFn: () => attachAccount(personId as string, null),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["org", "person", personId] });
    },
    onError: (e) => setError(errorMessage(e, t("person_page.account_failed"))),
  });

  // The other half of the link. Until now a person could be UNlinked from a
  // login but never linked to one, so granting access meant opening the
  // database and pasting a uuid no screen displayed.
  const waiting = useQuery({
    queryKey: ["org", "unattached-accounts"],
    queryFn: listUnattachedAccounts,
    enabled: myReach.data?.isAdmin === true && person.data?.account_id == null,
  });

  const attach = useMutation({
    mutationFn: (accountId: string) => attachAccount(personId as string, accountId),
    onSuccess: () => {
      setError(null);
      setChosenAccount("");
      queryClient.invalidateQueries({ queryKey: ["org", "person", personId] });
      queryClient.invalidateQueries({ queryKey: ["org", "unattached-accounts"] });
    },
    onError: (e) => setError(errorMessage(e, t("person_page.account_failed"))),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!personId) throw new Error("person required");
      if (canEditProfile) {
        // Editing yourself without maintain rights sends contact details only.
        // org_guard_persons refuses the rest, and sending a field the caller
        // may not change turns an unrelated save into a permission error.
        await updatePersonProfile(
          personId,
          canMaintainProfile
            ? {
                ...profilePatchOf(draft),
                full_name: draft.fullName,
                phone: draft.phone.trim() || null,
                email: draft.email.trim() || null,
              }
            : {
                phone: draft.phone.trim() || null,
                email: draft.email.trim() || null,
              },
        );
      }
      // Bank details are a separate capability on purpose: editing a profile
      // must not reach payroll.
      if (canMaintainBank) {
        const patch = bankPatchOf(draft);
        if (Object.keys(patch).length > 0) {
          await savePersonBankDetails(personId, patch);
        }
      }
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["org", "person", personId] });
      queryClient.invalidateQueries({
        queryKey: ["org", "person-bank", personId],
      });
      queryClient.invalidateQueries({ queryKey: ["org", "tree"] });
      queryClient.invalidateQueries({ queryKey: ["org", "persons"] });
    },
    onError: (e) => {
      setSaved(false);
      setError(errorMessage(e, t("person_page.save_failed")));
    },
  });

  if (!personId) return <ErrorState message={t("person_page.not_found")} />;
  if (person.isLoading || myReach.isLoading) return <ListSkeleton rows={4} />;
  if (person.isError) {
    return <ErrorState message={errorMessage(person.error, t("person_page.load_failed"))} />;
  }
  if (!person.data) {
    return (
      <Empty title={t("person_page.not_found")} description={t("person_page.not_found_hint")} />
    );
  }

  const p = person.data;
  const readOnly = !canEditProfile && !canMaintainBank;

  return (
    <div className="space-y-6">
      <div>
        {nodeId && (
          <Link to={`/org/node/${nodeId}`} className="text-sm text-primary-text hover:underline">
            ← {t("person_page.back_to_node")}
          </Link>
        )}
        <h1 className="font-display text-2xl font-semibold text-ink">{p.full_name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Pill>{p.employee_code}</Pill>
          <Pill tone={p.account_id ? "accent" : "neutral"}>
            {p.account_id ? t("person_page.has_login") : t("person_page.no_login")}
          </Pill>
          <Pill tone={p.status === "active" ? "success" : "warning"}>
            {t(`person_status.${p.status}`)}
          </Pill>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {saved && !save.isPending && <Alert variant="success">{t("person_page.saved")}</Alert>}

      {canMaintainProfile && (
        <Section title={t("person_page.employment")} description={t("person_page.employment_hint")}>
          <div className="space-y-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("person_page.status_now")}</span>
              <Pill tone={p.status === "active" ? "success" : "warning"}>
                {t(`person_status.${p.status}`)}
              </Pill>
            </div>

            {p.status !== "active" && (
              <Alert variant="warning">{t("person_page.inactive_no_authority")}</Alert>
            )}

            <div className="flex flex-wrap gap-2">
              {p.status !== "active" && (
                <Button
                  variant="secondary"
                  disabled={changeStatus.isPending}
                  onClick={() => changeStatus.mutate("active")}
                >
                  {t("person_page.reactivate")}
                </Button>
              )}
              {p.status !== "suspended" && (
                <Button
                  variant="secondary"
                  disabled={changeStatus.isPending}
                  onClick={() => changeStatus.mutate("suspended")}
                >
                  {t("person_page.suspend")}
                </Button>
              )}
              {p.status !== "departed" && (
                <Button
                  variant="danger"
                  disabled={changeStatus.isPending}
                  onClick={() => changeStatus.mutate("departed")}
                >
                  {t("person_page.depart")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("person_page.status_hint")}</p>

            {/* Only the sysadmin or the CEO may link or unlink an account --
                org_guard_persons refuses everyone else, so the control is not
                drawn for them rather than drawn and failing. */}
            {myReach.data?.isAdmin && (
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-sm font-medium text-foreground">{t("person_page.login")}</p>
                {p.account_id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="accent">{t("person_page.has_login")}</Pill>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={detach.isPending}
                      onClick={() => detach.mutate()}
                    >
                      {t("person_page.detach_login")}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">{t("person_page.no_login_yet")}</p>
                    {waiting.isLoading ? (
                      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                    ) : (waiting.data ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("person_page.no_account_waiting")}
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[16rem] flex-1">
                          <Label htmlFor="attach-account">
                            {t("person_page.attach_login_label")}
                          </Label>
                          <Select
                            value={chosenAccount}
                            onChange={setChosenAccount}
                            disabled={attach.isPending}
                            options={[
                              { value: "", label: t("person_page.attach_login_choose") },
                              ...(waiting.data ?? []).map((a) => ({
                                value: a.account_id,
                                label: a.email,
                              })),
                            ]}
                          />
                        </div>
                        <Button
                          size="sm"
                          disabled={!chosenAccount || attach.isPending}
                          onClick={() => attach.mutate(chosenAccount)}
                        >
                          {t("person_page.attach_login")}
                        </Button>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("person_page.attach_login_hint")}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      <Section
        title={t("person_page.details")}
        description={readOnly ? t("person_page.read_only") : t("person_page.details_hint")}
      >
        <div className="py-2">
          <PersonDetailsFields
            draft={draft}
            onChange={(patch) => {
              setDraft((d) => ({ ...d, ...patch }));
              setSaved(false);
            }}
            canMaintainProfile={canEditProfile}
            canMaintainBank={canMaintainBank}
            disabled={save.isPending || readOnly}
            employmentReadOnly={!canMaintainProfile}
            idPrefix="person-page"
          />
          {!readOnly && (
            <div className="mt-4 flex justify-end">
              <Button
                onClick={() => save.mutate()}
                disabled={save.isPending || !draft.fullName.trim()}
              >
                {save.isPending ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          )}
        </div>
      </Section>

      <FaceEnrollmentPanel
        personId={personId}
        canEnroll={canMaintainProfile || (isSelf && canSelfEnroll)}
      />
    </div>
  );
}
