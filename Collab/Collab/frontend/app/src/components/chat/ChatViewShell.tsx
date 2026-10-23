// ChatViewShell.tsx — ChatView render shell (mechanical extraction from ChatView.tsx).
// Do not hand-edit beyond imports.

import ChatColumn from "./ChatColumn";
import ChatDetails from "./ChatDetails";
import AvatarCropModal from "../AvatarCropModal";
import { Welcome } from "./TabPane";

export default function ChatViewShell({ s }: { s: any }) {
  const {
    convAvatarCropFile, conversation, flash, infoRender,
    onUploadAvatar, onUploadConversationAvatar, setConvAvatarCropFile
  } = s;

  if (!conversation) {
    return <Welcome />;
  }

  return (
    <>
      {/* Inject keyframe animations needed for mobile sheet + portal overlays */}
      <style>{`
        @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slide-up { from { transform: translateY(100%) } to { transform: translateY(0) } }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
        .msg-flash { background: var(--highlight-bg, rgba(251,211,141,0.35)) !important; transition: background 0.4s; }
      `}</style>

      <div className={"view active" + (infoRender ? " info-open" : "")} id="vc">
        {/* Chat column — the Details panel below is a docked SIBLING that pushes
            this column (flex row), not an overlay that covers it. */}
        <ChatColumn s={s} />
        {/* /.cv-col */}

        {/* Details — docked, content-pushing right sidebar (see .info-panel).
            Kept mounted through its slide-out via infoRender so the close
            animates like the conversation sidebars; .info-inner holds a fixed
            width so the content never reflows while the panel width animates. */}
        <ChatDetails s={s} />
        {convAvatarCropFile ? (
          <AvatarCropModal
            file={convAvatarCropFile}
            onCancel={() => setConvAvatarCropFile(null)}
            onConfirm={(cropped) => {
              setConvAvatarCropFile(null);
              if (conversation.kind === "self") onUploadAvatar?.(cropped);
              else onUploadConversationAvatar?.(conversation.id, cropped);
            }}
          />
        ) : null}
      </div>
    </>
  );
}
