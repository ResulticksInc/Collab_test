import { IconX } from "../../lib/icons";
import { Select } from "../ui";

// Microphone / camera / speaker picker (Phase 0 decomposition — extracted from
// MeetingStage). Presentational: the parent owns device enumeration and the
// actual track switching, because those touch the LiveKit room.
//
// The `tab` prop is why this is one component rather than three: the dock's
// mic chevron opens it scoped to audio, the camera chevron to video, and the
// More menu to both. Rendering only the relevant rows keeps the popup small
// instead of showing a camera picker to someone adjusting their microphone.

export interface MediaDevice {
  deviceId: string;
  label?: string;
}

export interface DeviceSettingsProps {
  open: boolean;
  tab: "audio" | "video" | "all" | string;
  devices: { mics: MediaDevice[]; cams: MediaDevice[]; speakers: MediaDevice[] };
  selMic: string;
  selCam: string;
  selSpk: string;
  /** setSinkId support — absent on Firefox and Safari, where the OS decides. */
  sinkSupported: boolean;
  onSwitchMic: (id: string) => void;
  onSwitchCam: (id: string) => void;
  onSwitchSpeaker: (id: string) => void;
  onClose: () => void;
}

export default function DeviceSettings({
  open,
  tab,
  devices,
  selMic,
  selCam,
  selSpk,
  sinkSupported,
  onSwitchMic,
  onSwitchCam,
  onSwitchSpeaker,
  onClose,
}: DeviceSettingsProps) {
  if (!open) return null;
  const row = (
    label: string,
    list: MediaDevice[],
    value: string,
    onChange: (id: string) => void,
    fallback: string,
  ) => (
    <label className="ms-device-row">
      <span className="ms-device-label">{label}</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ms-device-sel"
      >
        {list.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || fallback}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <div className="ms-device-popup-v2">
      <div className="ms-device-popup-head">
        {tab === "audio"
          ? "Audio settings"
          : tab === "video"
            ? "Camera settings"
            : "Audio & video settings"}
        <button
          onClick={onClose}
          className="ms-device-popup-close"
          aria-label="Close settings"
        >
          <IconX size={15} />
        </button>
      </div>
      {devices.mics.length > 0 &&
        tab !== "video" &&
        row("Microphone", devices.mics, selMic, onSwitchMic, "Microphone")}
      {devices.cams.length > 0 &&
        tab !== "audio" &&
        row("Camera", devices.cams, selCam, onSwitchCam, "Camera")}
      {sinkSupported &&
        devices.speakers.length > 0 &&
        tab !== "video" &&
        row("Speaker", devices.speakers, selSpk, onSwitchSpeaker, "Speaker")}
    </div>
  );
}
