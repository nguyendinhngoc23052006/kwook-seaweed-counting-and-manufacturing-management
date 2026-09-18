import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useRef, useState } from "react";
import { FACE_MODEL_VERSION } from "../../attendance/attendanceLogic";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  enrollFace,
  getFaceEnrollment,
  getPersonPhotoUrl,
  uploadPersonPhoto,
} from "../../services/attendance";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { Section } from "../ui/Section";

type Phase = "idle" | "analysing" | "uploading";

const MAX_SIDE = 800;

// Distinct from a thrown Supabase/network error, so onError picks the right message.
class NoFaceFoundError extends Error {}

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read image"));
    };
    img.src = url;
  });
}

// Scaled down before detection: a smaller upload, a faster detector pass.
function drawScaledDown(img: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("could not encode photo"))),
      "image/jpeg",
      0.9,
    );
  });
}

export function FaceEnrollmentPanel({
  personId,
  canEnroll,
}: {
  personId: string;
  canEnroll: boolean;
}): JSX.Element {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const enrollment = useQuery({
    queryKey: ["org", "face-enrollment", personId],
    queryFn: () => getFaceEnrollment(personId),
    enabled: !!personId,
  });

  const photoPath = enrollment.data?.photo_path;
  const photo = useQuery({
    queryKey: ["org", "person-photo", photoPath],
    queryFn: () => getPersonPhotoUrl(photoPath as string),
    enabled: !!photoPath,
  });

  const enroll = useMutation({
    mutationFn: async (file: File) => {
      setPhase("analysing");
      const img = await loadImage(file);
      const canvas = drawScaledDown(img);
      const engine = await import("../../attendance/faceEngine");
      await engine.loadFaceModels();
      const faces = await engine.describeFaces(canvas);
      const largest = faces.reduce<(typeof faces)[number] | null>((best, face) => {
        const area = face.box.width * face.box.height;
        const bestArea = best ? best.box.width * best.box.height : -1;
        return area > bestArea ? face : best;
      }, null);
      if (!largest) throw new NoFaceFoundError();

      setPhase("uploading");
      const blob = await canvasToJpeg(canvas);
      const path = await uploadPersonPhoto(personId, blob);
      await enrollFace({
        personId,
        embedding: largest.descriptor,
        modelVersion: FACE_MODEL_VERSION,
        photoPath: path,
      });
    },
    onSuccess: () => {
      setPhase("idle");
      setError(null);
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["org", "face-enrollment", personId] });
    },
    onError: (e) => {
      setPhase("idle");
      setSaved(false);
      setError(
        e instanceof NoFaceFoundError
          ? t("face.no_face")
          : errorMessage(e, t("face.enroll_failed")),
      );
    },
  });

  const label =
    phase === "analysing"
      ? t("face.analysing")
      : phase === "uploading"
        ? t("face.uploading")
        : t("face.choose_photo");

  return (
    <Section title={t("face.title")} description={t("face.hint")}>
      <div className="space-y-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          {photo.data && (
            <img src={photo.data} alt="" className="h-24 w-24 rounded-full object-cover" />
          )}
          {enrollment.data ? (
            <Pill tone="success">
              {t("face.enrolled", {
                date: new Date(enrollment.data.enrolled_at).toLocaleDateString(
                  locale === "vi" ? "vi-VN" : "en-US",
                ),
              })}
            </Pill>
          ) : (
            <Pill tone="warning">{t("face.not_enrolled")}</Pill>
          )}
        </div>

        {/* The doors only compare embeddings made by the model they run; an
            enrolment from an older one silently never matches. */}
        {enrollment.data && enrollment.data.model_version !== FACE_MODEL_VERSION && (
          <Alert variant="warning">{t("face.stale_model")}</Alert>
        )}

        {error && <Alert variant="error">{error}</Alert>}
        {saved && !enroll.isPending && <Alert variant="success">{t("face.enrolled_ok")}</Alert>}

        {canEnroll ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setSaved(false);
                setError(null);
                enroll.mutate(file);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={enroll.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              {label}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">{t("face.read_only")}</p>
        )}
      </div>
    </Section>
  );
}
