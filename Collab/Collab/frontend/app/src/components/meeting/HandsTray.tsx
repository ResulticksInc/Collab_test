import { IconHand, IconX } from "../../lib/icons";

// Floating tray of raised hands (Phase 0 decomposition — extracted from
// MeetingStage). Purely presentational: it takes the current hands and renders
// them, and calls back when a host lowers one.
//
// Shows at most five chips and collapses the rest into a "+N more" count — a
// large meeting can otherwise fill the stage with hands and hide the video
// behind the very thing people raised their hand to talk about.

export interface HandsTrayProps {
  /** User ids with a raised hand, in the order the server reports them. */
  raisedHands: string[];
  /** Live participants, used to resolve a current display name. */
  participants: Array<{ userId: string; name?: string }>;
  /** Fallback names for people the client has not resolved a tile for yet. */
  handNames: Record<string, string>;
  /** Host or co-host — only they may lower someone else's hand. */
  canControl: boolean;
  onLowerHand: (userId: string) => void;
  /** How many chips before collapsing into "+N more". */
  maxVisible?: number;
}

export default function HandsTray({
  raisedHands,
  participants,
  handNames,
  canControl,
  onLowerHand,
  maxVisible = 5,
}: HandsTrayProps) {
  if (!raisedHands.length) return null;
  const hidden = raisedHands.length - maxVisible;
  return (
    <div className="ms-hands-tray">
      {raisedHands.slice(0, maxVisible).map((uid) => {
        const p = participants.find((x) => x.userId === uid);
        const displayName = (p && p.name) || handNames[uid] || "Participant";
        return (
          <div key={uid} className="ms-hand-chip">
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              <IconHand size={14} />
            </span>
            <span>{displayName}</span>
            {canControl && (
              <button
                className="ms-hand-lower"
                onClick={() => onLowerHand(uid)}
                title="Lower hand"
              >
                <IconX size={13} />
              </button>
            )}
          </div>
        );
      })}
      {hidden > 0 && <span className="ms-hands-more">+{hidden} more</span>}
    </div>
  );
}
