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
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import {
  getPerson,
  getPersonBankDetails,
  savePersonBankDetails,
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

  const save = useMutation({
    mutationFn: async () => {
      if (!personId) throw new Error("person required");
      if (canEditProfile) {
        await updatePersonProfile(personId, {
          ...profilePatchOf(draft),
          full_name: draft.fullName,
          phone: draft.phone.trim() || null,
          email: draft.email.trim() || null,
        });
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
          <Link to={`/org/node/${nodeId}`} className="text-sm text-accent-text hover:underline">
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

      <FaceEnrollmentPanel personId={personId} canEnroll={canEditProfile} />
    </div>
  );
}
