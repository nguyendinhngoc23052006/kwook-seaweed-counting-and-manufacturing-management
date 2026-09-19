import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { ListRow, ListRows } from "../../components/ui/ListRow";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  type BookedInterviewSlot,
  bookInterviewSlot,
  interviewSlotsForApplication,
} from "../../services/interviewSlots";

function formatSlotRange(startsAt: string, endsAt: string, locale: string): string {
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = start.toLocaleDateString(tag, { weekday: "short", day: "numeric", month: "short" });
  const from = start.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  const to = end.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${from}–${to}`;
}

// No account, so the only record of "you already booked" a candidate's own
// browser can hold is what it saved itself last time -- same anonymous
// posture as the rest of this flow (the application id already in the URL is
// the capability token; org_book_interview_slot() re-verifies it server-side
// regardless of what this cache says).
function bookingStorageKey(applicationId: string): string {
  return `interview-booking:${applicationId}`;
}

function readSavedBooking(applicationId: string | undefined): BookedInterviewSlot | null {
  if (!applicationId) return null;
  try {
    const raw = localStorage.getItem(bookingStorageKey(applicationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookedInterviewSlot;
    return typeof parsed.starts_at === "string" && typeof parsed.ends_at === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function saveBooking(applicationId: string, booking: BookedInterviewSlot): void {
  try {
    localStorage.setItem(bookingStorageKey(applicationId), JSON.stringify(booking));
  } catch {
    // Best effort only: a failed save just means a reload re-prompts the
    // candidate to pick again, which the server still handles correctly.
  }
}

// The candidate's side of interview scheduling: no login, so the application
// id in the URL is the whole capability (see interviewSlots.ts). Mirrors
// ApplyPage's shape -- same PublicLayout, same loading/empty/error states.
export function InterviewBookingPage(): JSX.Element {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { t, locale } = useI18n();
  const [booked, setBooked] = useState<BookedInterviewSlot | null>(() =>
    readSavedBooking(applicationId),
  );
  const [error, setError] = useState<string | null>(null);

  const openSlots = useQuery({
    queryKey: ["interviews", "openSlots", applicationId ?? null],
    queryFn: () => interviewSlotsForApplication(applicationId ?? ""),
    enabled: Boolean(applicationId) && !booked,
  });

  const book = useMutation({
    mutationFn: (slotId: string) => bookInterviewSlot(applicationId ?? "", slotId),
    onSuccess: (result) => {
      setError(null);
      setBooked(result);
      if (applicationId) saveBooking(applicationId, result);
    },
    onError: (e) => setError(errorMessage(e, t("interviews.book_failed"))),
  });

  if (!applicationId) {
    return <Empty title={t("interviews.invalid_link")} />;
  }

  if (booked) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-display text-2xl font-bold text-ink">
          {t("interviews.confirmed_title")}
        </h1>
        <p className="text-base leading-relaxed text-ink-muted">
          {t("interviews.confirmed_body", {
            time: formatSlotRange(booked.starts_at, booked.ends_at, locale),
          })}
        </p>
        <Link
          to="/"
          className="inline-flex min-h-11 items-center text-sm text-primary-text hover:underline"
        >
          {t("public.back_to_roles")}
        </Link>
      </div>
    );
  }

  if (openSlots.isLoading) {
    return <ListSkeleton rows={3} label={t("interviews.candidate_loading")} />;
  }
  if (openSlots.isError) {
    return (
      <ErrorState
        message={errorMessage(openSlots.error, t("interviews.candidate_load_failed"))}
        action={<Button onClick={() => openSlots.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const slots = openSlots.data ?? [];
  if (slots.length === 0) {
    return (
      <Empty title={t("interviews.no_slots_title")} description={t("interviews.no_slots_body")} />
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">
          {t("interviews.candidate_title")}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("interviews.intro")}</p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <ListRows>
        {slots.map((slot) => (
          <ListRow
            key={slot.id}
            title={formatSlotRange(slot.starts_at, slot.ends_at, locale)}
            onClick={book.isPending ? undefined : () => book.mutate(slot.id)}
            meta={
              <Pill tone={slot.remaining <= 1 ? "warning" : "neutral"}>
                {t("interviews.remaining_n", { n: slot.remaining })}
              </Pill>
            }
          />
        ))}
      </ListRows>
    </div>
  );
}
