// Floating reaction bubbles (Phase 0 decomposition — extracted from
// MeetingStage). Presentational only: the parent owns the list and expires each
// entry on a timer, so this component has no state and no effects.

export interface FloatingReaction {
  id: string;
  emoji: string;
  name: string;
}

export default function ReactionsOverlay({
  reactions,
}: {
  reactions: FloatingReaction[];
}) {
  if (!reactions.length) return null;
  return (
    <div className="ms-floating-reactions">
      {reactions.map((r) => (
        <div key={r.id} className="ms-float-reaction">
          <span className="ms-float-emoji">{r.emoji}</span>
          <span className="ms-float-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}
