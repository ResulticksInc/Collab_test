import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { subscribeStudio, closeStudio, type StudioRequest } from "../lib/studio";

const MediaStudio = dynamic(() => import("./MediaStudio"), { ssr: false });

// Single app-wide host for the sticker/GIF creation studio. Mounted once at the
// CoLabV1 root (sibling of DialogHost / the comms sidebar) and portaled to
// <body> so its own z-layer (var(--z-studio)) sits above the call stage, the
// comms sidebar, and the GIF picker in every context — calls, meetings, and the
// main chat alike. It receives a token GETTER from the root (so uploads read the
// CURRENT token even if it rotated) and hands the created media back through the
// studio store's promise.
export default function MediaStudioHost({ getToken }: { getToken: () => string | null }) {
  const [req, setReq] = useState<StudioRequest | null>(null);

  useEffect(() => subscribeStudio(setReq), []);

  if (!req || typeof document === "undefined") return null;

  return createPortal(
    <MediaStudio
      key={req.id}
      getToken={getToken}
      mode={req.mode}
      onClose={(media) => closeStudio(req.id, media)}
    />,
    document.body,
  );
}
