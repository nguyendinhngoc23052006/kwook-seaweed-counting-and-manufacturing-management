import { type JSX, useState } from "react";
import { useT } from "../../lib/i18n";
import type { PersonBankPatch, PersonProfilePatch } from "../../services/people";
import { Alert } from "../ui/Alert";
import { Input, Label } from "../ui/Input";

// One draft shape for both doorways: the field manager who creates a worker and
// the office manager who fills an empty seat type the same person.
export interface PersonDraft {
  fullName: string;
  phone: string;
  email: string;
  hireDate: string;
  photoUrl: string;
  dateOfBirth: string;
  nationalId: string;
  address: string;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  branch: string;
}

export const emptyPersonDraft: PersonDraft = {
  fullName: "",
  phone: "",
  email: "",
  hireDate: "",
  photoUrl: "",
  dateOfBirth: "",
  nationalId: "",
  address: "",
  bankName: "",
  accountHolder: "",
  accountNumber: "",
  branch: "",
};

// Only the fields the user actually filled in are sent. An empty box means
// "not known yet", never "blank this out" — the person may already carry a
// value another maintainer typed.
export function profilePatchOf(draft: PersonDraft): PersonProfilePatch {
  const patch: PersonProfilePatch = {};
  if (draft.photoUrl.trim()) patch.photo_url = draft.photoUrl.trim();
  if (draft.dateOfBirth.trim()) patch.date_of_birth = draft.dateOfBirth.trim();
  if (draft.nationalId.trim()) patch.national_id = draft.nationalId.trim();
  if (draft.address.trim()) patch.address = draft.address.trim();
  return patch;
}

export function bankPatchOf(draft: PersonDraft): PersonBankPatch {
  const patch: PersonBankPatch = {};
  if (draft.bankName.trim()) patch.bank_name = draft.bankName.trim();
  if (draft.accountHolder.trim()) {
    patch.account_holder = draft.accountHolder.trim();
  }
  if (draft.accountNumber.trim()) {
    patch.account_number = draft.accountNumber.trim();
  }
  if (draft.branch.trim()) patch.branch = draft.branch.trim();
  return patch;
}

interface Props {
  draft: PersonDraft;
  onChange: (patch: Partial<PersonDraft>) => void;
  // Profile and bank details are separate capabilities. A creator who holds
  // neither still creates the person — those sections are hidden rather than
  // disabled, and a line says who can fill them in.
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
  disabled: boolean;
  idPrefix: string;
}

export function PersonDetailsFields(props: Props): JSX.Element {
  const { draft, onChange, canMaintainProfile, canMaintainBank, disabled, idPrefix } = props;
  const t = useT();
  const [photoBroken, setPhotoBroken] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={`${idPrefix}-full-name`}>{t("person_form.full_name")}</Label>
        <Input
          id={`${idPrefix}-full-name`}
          value={draft.fullName}
          onChange={(e) => onChange({ fullName: e.target.value })}
          placeholder={t("person_form.full_name_placeholder")}
          autoComplete="off"
          disabled={disabled}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${idPrefix}-phone`}>{t("person_form.phone")}</Label>
          <Input
            id={`${idPrefix}-phone`}
            type="tel"
            inputMode="tel"
            value={draft.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-email`}>{t("person_form.email")}</Label>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            inputMode="email"
            value={draft.email}
            onChange={(e) => onChange({ email: e.target.value })}
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <Label htmlFor={`${idPrefix}-hire-date`}>{t("person_form.hire_date")}</Label>
        <Input
          id={`${idPrefix}-hire-date`}
          type="date"
          value={draft.hireDate}
          onChange={(e) => onChange({ hireDate: e.target.value })}
          disabled={disabled}
        />
      </div>

      <p className="text-xs text-ink-muted">{t("person_form.no_login_hint")}</p>

      {canMaintainProfile ? (
        <div className="space-y-4 border-t border-hairline pt-4">
          <div>
            <Label htmlFor={`${idPrefix}-photo`}>{t("person_form.photo_url")}</Label>
            <Input
              id={`${idPrefix}-photo`}
              type="url"
              inputMode="url"
              value={draft.photoUrl}
              onChange={(e) => {
                setPhotoBroken(false);
                onChange({ photoUrl: e.target.value });
              }}
              placeholder="https://"
              disabled={disabled}
            />
            <p className="mt-1 text-xs text-ink-muted">{t("person_form.photo_hint")}</p>
            {draft.photoUrl.trim() !== "" &&
              (photoBroken ? (
                <p className="mt-2 text-xs text-danger-text">{t("person_form.photo_broken")}</p>
              ) : (
                <img
                  src={draft.photoUrl}
                  alt={t("person_form.photo_preview_alt")}
                  onError={() => setPhotoBroken(true)}
                  className="mt-2 size-20 rounded-lg border border-hairline object-cover"
                />
              ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${idPrefix}-dob`}>{t("person_form.date_of_birth")}</Label>
              <Input
                id={`${idPrefix}-dob`}
                type="date"
                value={draft.dateOfBirth}
                onChange={(e) => onChange({ dateOfBirth: e.target.value })}
                disabled={disabled}
              />
            </div>
            <div>
              <Label htmlFor={`${idPrefix}-national-id`}>{t("person_form.national_id")}</Label>
              <Input
                id={`${idPrefix}-national-id`}
                value={draft.nationalId}
                onChange={(e) => onChange({ nationalId: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>

          <div>
            <Label htmlFor={`${idPrefix}-address`}>{t("person_form.address")}</Label>
            <Input
              id={`${idPrefix}-address`}
              value={draft.address}
              onChange={(e) => onChange({ address: e.target.value })}
              disabled={disabled}
            />
          </div>
        </div>
      ) : (
        <p className="border-t border-hairline pt-4 text-xs text-ink-muted">
          {t("person_form.no_profile_capability")}
        </p>
      )}

      {canMaintainBank ? (
        <div className="space-y-4 border-t border-hairline pt-4">
          <Alert variant="warning">{t("person_form.bank_warning")}</Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${idPrefix}-bank-name`}>{t("person_form.bank_name")}</Label>
              <Input
                id={`${idPrefix}-bank-name`}
                value={draft.bankName}
                onChange={(e) => onChange({ bankName: e.target.value })}
                disabled={disabled}
              />
            </div>
            <div>
              <Label htmlFor={`${idPrefix}-bank-branch`}>{t("person_form.bank_branch")}</Label>
              <Input
                id={`${idPrefix}-bank-branch`}
                value={draft.branch}
                onChange={(e) => onChange({ branch: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-bank-holder`}>{t("person_form.account_holder")}</Label>
            <Input
              id={`${idPrefix}-bank-holder`}
              value={draft.accountHolder}
              onChange={(e) => onChange({ accountHolder: e.target.value })}
              disabled={disabled}
            />
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-bank-number`}>{t("person_form.account_number")}</Label>
            <Input
              id={`${idPrefix}-bank-number`}
              inputMode="numeric"
              value={draft.accountNumber}
              onChange={(e) => onChange({ accountNumber: e.target.value })}
              disabled={disabled}
            />
          </div>
        </div>
      ) : (
        <p className="border-t border-hairline pt-4 text-xs text-ink-muted">
          {t("person_form.no_bank_capability")}
        </p>
      )}
    </div>
  );
}
