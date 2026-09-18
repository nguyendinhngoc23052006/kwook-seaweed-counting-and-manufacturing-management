import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { FaceEnrollmentPanel } from "../../components/org/FaceEnrollmentPanel";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { getMyCapabilityReach } from "../../services/capabilities";
import { getMyProfile, type MyProfilePatch, updateMyProfile } from "../../services/profiles";
import type { CameraCapabilityKey } from "../../types/camera";

// "Ho so cua toi" -- the signed-in person's own seats, rank and capabilities,
// plus the two contact fields (display name, phone) they may correct
// themselves. Kwook Management Hub's equivalent page edited a flat `profiles` row
// (display_name, phone, locale) under a set_role() hierarchy; Kwook has
// neither a profiles table nor set_role(), so this reads the person's own
// seats and the same camera-capability reach query CamerasPage/NodePage/
// UnitPage already use, rather than inventing a parallel permissions view.
//
// The two capability keys shown are the only ones services/capabilities.ts
// currently queries reach for -- this repo has no general org-tree browsing UI
// yet, so a third capability appearing here waits on that query growing, not
// on this page inventing its own.
const CAPABILITY_KEYS: CameraCapabilityKey[] = ["manage_camera_devices", "view_camera_data"];

export function ProfilePage(): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ["profile", "me"],
    queryFn: getMyProfile,
  });

  const reach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });

  // Prefill once, the same guard PersonPage.tsx uses: sync from the loaded
  // row exactly once so the form does not fight the person's own typing on
  // every background refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only sync when the profile first loads; don't re-sync on user typing
  useEffect(() => {
    const person = profile.data?.person;
    if (person && !prefilled) {
      setDisplayName(person.display_name ?? "");
      setPhone(person.phone ?? "");
      setPrefilled(true);
    }
  }, [profile.data]);

  const save = useMutation({
    mutationFn: (patch: MyProfilePatch) => updateMyProfile(patch),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["profile", "me"] });
    },
    onError: (e) => {
      setSaved(false);
      setError(errorMessage(e, t("profile.save_failed")));
    },
  });

  if (profile.isLoading) return <ListSkeleton rows={4} />;

  if (profile.isError) {
    return <ErrorState message={errorMessage(profile.error, t("profile.load_failed"))} />;
  }

  const data = profile.data;
  const person = data?.person ?? null;
  // enroll_own_face is a privilege, not a default: a coworker with camera
  // access must not be able to enrol someone else's face as their own.
  const canSelfEnroll =
    reach.data?.isAdmin === true || (reach.data?.byKey.enroll_own_face?.length ?? 0) > 0;

  function handleSave() {
    setSaved(false);
    save.mutate({
      display_name: displayName.trim() || null,
      phone: phone.trim() || null,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">{t("profile.title")}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t("profile.subtitle")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {person && <Pill>{person.employee_code}</Pill>}
          {person && (
            <Pill tone={person.status === "active" ? "success" : "warning"}>
              {t(`person_status.${person.status}`)}
            </Pill>
          )}
          {person && (
            <Pill tone={person.account_id ? "accent" : "neutral"}>
              {person.account_id ? t("person_page.has_login") : t("person_page.no_login")}
            </Pill>
          )}
          {data?.isAdmin && <Pill tone="accent">{t("profile.admin_badge")}</Pill>}
        </div>
      </div>

      {!person && (
        <Empty
          title={t("profile.no_person_title")}
          description={
            data?.isAdmin ? t("profile.no_person_admin_hint") : t("profile.no_person_hint")
          }
        />
      )}

      <Section title={t("profile.positions_title")} description={t("profile.positions_hint")}>
        {data && data.positions.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {data.positions.map(({ position, rank, node }) => (
              <li key={position.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="font-medium text-ink">{position.title}</span>
                <Pill tone="accent">{rank.name_vi}</Pill>
                <span className="text-sm text-ink-muted">{node.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-ink-muted">{t("profile.no_positions")}</p>
        )}
      </Section>

      <Section title={t("profile.capabilities_title")} description={t("profile.capabilities_hint")}>
        {reach.isLoading ? (
          <ListSkeleton rows={2} />
        ) : reach.isError ? (
          <p className="py-2 text-sm text-danger-text">
            {errorMessage(reach.error, t("profile.capabilities_load_failed"))}
          </p>
        ) : data?.isAdmin ? (
          <p className="py-2 text-sm text-ink-muted">{t("profile.admin_reaches_everything")}</p>
        ) : (
          (() => {
            const held = CAPABILITY_KEYS.filter((key) => (reach.data?.byKey[key] ?? []).length > 0);
            return held.length > 0 ? (
              <div className="flex flex-wrap gap-2 py-2">
                {held.map((key) => (
                  <Pill key={key} tone="accent">
                    {t(`capability.${key}`)}
                  </Pill>
                ))}
              </div>
            ) : (
              <p className="py-2 text-sm text-ink-muted">{t("profile.no_capabilities")}</p>
            );
          })()
        )}
      </Section>

      {person && <FaceEnrollmentPanel personId={person.id} canEnroll={canSelfEnroll} />}

      {person && (
        <Section title={t("profile.contact_title")} description={t("profile.contact_hint")}>
          <div className="space-y-4 py-2">
            {person.email && (
              <div>
                <Label>{t("profile.email")}</Label>
                <p className="text-sm text-ink">{person.email}</p>
              </div>
            )}

            <div>
              <Label htmlFor="profile-display-name">{t("profile.display_name")}</Label>
              <Input
                id="profile-display-name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setSaved(false);
                }}
                disabled={save.isPending}
              />
            </div>

            <div>
              <Label htmlFor="profile-phone">{t("profile.phone")}</Label>
              <Input
                id="profile-phone"
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setSaved(false);
                }}
                disabled={save.isPending}
              />
            </div>

            {error && <Alert variant="error">{error}</Alert>}
            {saved && !save.isPending && <Alert variant="success">{t("profile.saved")}</Alert>}

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={save.isPending}>
                {save.isPending ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
