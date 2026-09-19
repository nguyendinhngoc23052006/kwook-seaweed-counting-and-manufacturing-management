import { useMutation } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { parseAttendanceConfig } from "../../attendance/attendanceLogic";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { setAttendanceConfig } from "../../services/attendance";
import type { CameraDevice } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { Select } from "../ui/Select";

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  step,
  min,
  max,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  step: number;
  min: number;
  max: number;
  disabled: boolean;
}): JSX.Element {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

export function AttendanceConfigDialog({
  device,
  open,
  onClose,
  onSaved,
}: {
  device: CameraDevice;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const t = useT();
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [zoneX, setZoneX] = useState("");
  const [zoneY, setZoneY] = useState("");
  const [zoneW, setZoneW] = useState("");
  const [zoneH, setZoneH] = useState("");
  const [minFaceRatio, setMinFaceRatio] = useState("");
  const [stableFrames, setStableFrames] = useState("");
  const [matchThreshold, setMatchThreshold] = useState("");
  const [cooldownSeconds, setCooldownSeconds] = useState("");
  const [flashMs, setFlashMs] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: device.attendance_config only seeds local state on open, not tracked live.
  useEffect(() => {
    if (!open) return;
    const config = parseAttendanceConfig(device.attendance_config);
    setFacing(config.facing);
    setZoneX(String(config.zone.x));
    setZoneY(String(config.zone.y));
    setZoneW(String(config.zone.w));
    setZoneH(String(config.zone.h));
    setMinFaceRatio(String(config.minFaceRatio));
    setStableFrames(String(config.stableFrames));
    setMatchThreshold(String(config.matchThreshold));
    setCooldownSeconds(String(config.cooldownSeconds));
    setFlashMs(String(config.flashMs));
  }, [open, device.id]);

  const save = useMutation({
    mutationFn: () =>
      setAttendanceConfig(device.id, {
        zone: { x: Number(zoneX), y: Number(zoneY), w: Number(zoneW), h: Number(zoneH) },
        min_face_ratio: Number(minFaceRatio),
        stable_frames: Number(stableFrames),
        match_threshold: Number(matchThreshold),
        cooldown_seconds: Number(cooldownSeconds),
        flash_ms: Number(flashMs),
        facing,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("attendance_config.title", { name: device.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="attendance-facing">{t("attendance_config.facing")}</Label>
          <Select
            id="attendance-facing"
            value={facing}
            onChange={setFacing}
            options={[
              { value: "user", label: t("attendance_config.facing_user") },
              { value: "environment", label: t("attendance_config.facing_environment") },
            ]}
            disabled={save.isPending}
          />
        </div>

        <div>
          <Label>{t("attendance_config.zone")}</Label>
          {/* Un-layered `.grid` in styles.css beats Tailwind's grid-cols-4; force columns inline instead. */}
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            <NumberField
              id="attendance-zone-x"
              label={t("attendance_config.zone_x")}
              value={zoneX}
              onChange={setZoneX}
              step={0.05}
              min={0}
              max={1}
              disabled={save.isPending}
            />
            <NumberField
              id="attendance-zone-y"
              label={t("attendance_config.zone_y")}
              value={zoneY}
              onChange={setZoneY}
              step={0.05}
              min={0}
              max={1}
              disabled={save.isPending}
            />
            <NumberField
              id="attendance-zone-w"
              label={t("attendance_config.zone_w")}
              value={zoneW}
              onChange={setZoneW}
              step={0.05}
              min={0}
              max={1}
              disabled={save.isPending}
            />
            <NumberField
              id="attendance-zone-h"
              label={t("attendance_config.zone_h")}
              value={zoneH}
              onChange={setZoneH}
              step={0.05}
              min={0}
              max={1}
              disabled={save.isPending}
            />
          </div>
        </div>

        <NumberField
          id="attendance-min-face-ratio"
          label={t("attendance_config.min_face_ratio")}
          hint={t("attendance_config.min_face_ratio_hint")}
          value={minFaceRatio}
          onChange={setMinFaceRatio}
          step={0.01}
          min={0.05}
          max={1}
          disabled={save.isPending}
        />

        <NumberField
          id="attendance-stable-frames"
          label={t("attendance_config.stable_frames")}
          value={stableFrames}
          onChange={setStableFrames}
          step={1}
          min={1}
          max={30}
          disabled={save.isPending}
        />

        <NumberField
          id="attendance-match-threshold"
          label={t("attendance_config.match_threshold")}
          hint={t("attendance_config.match_threshold_hint")}
          value={matchThreshold}
          onChange={setMatchThreshold}
          step={0.05}
          min={0.1}
          max={0.8}
          disabled={save.isPending}
        />

        <NumberField
          id="attendance-cooldown-seconds"
          label={t("attendance_config.cooldown_seconds")}
          value={cooldownSeconds}
          onChange={setCooldownSeconds}
          step={1}
          min={0}
          max={86400}
          disabled={save.isPending}
        />

        <NumberField
          id="attendance-flash-ms"
          label={t("attendance_config.flash_ms")}
          value={flashMs}
          onChange={setFlashMs}
          step={1}
          min={0}
          max={3000}
          disabled={save.isPending}
        />

        {save.isError && (
          <Alert variant="error">
            {errorMessage(save.error, t("attendance_config.save_failed"))}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
