// TabPane.tsx — ChatView module-scope welcome + tab pane (lines 2474-2811).
// Mechanical extraction from ChatView.tsx. Do not hand-edit beyond imports.

import { useState, useEffect, useMemo } from "react";
import { IconDownload, IconLink, IconMessageCircle } from "../../lib/icons";
import { api } from "../../lib/api";
import { downloadAttachment } from "../../lib/downloadAttachment";
import { humanBytes } from "../../lib/fileLimits";
import { localTime } from "../../lib/time";
import { cleanUrl, extractLinksFromMessages, dotClass } from "./helpers";
import Avatar from "../Avatar";
import { FileThumb } from "./FileAttachment";
import { fileKeyIndex, withFileKeys } from "../../lib/fileThumbs";

export function Welcome() {
  return (
    <div className="view active" id="vw">
      <div className="welcome-art">
        <div className="logo-big"><IconMessageCircle size={48} /></div>
        <h2>Select a conversation</h2>
        <p>
          Choose a chat from the left to start messaging — or use search to find
          people, messages and files.
        </p>
      </div>
    </div>
  );
}

// ─── TabPane ─────────────────────────────────────────────────────────────────

export function TabPane({
  tab,
  token,
  conversation,
  offlineDemo,
  meId,
  onSelectPerson,
  messages,
}: any) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // File rows with the E2EE key merged in from the loaded messages, so image
  // rows can show a real thumbnail. Memoised: FileThumb's blob hook keys on
  // the file object's identity.
  const files = useMemo(
    () =>
      tab === "files" && Array.isArray(data)
        ? (() => {
            const idx = fileKeyIndex(messages);
            return data.map((f: any) => withFileKeys(f, idx));
          })()
        : [],
    [tab, data, messages],
  );

  useEffect(() => {
    let off = false;
    if (!token || offlineDemo) {
      setData([]);
      return;
    }
    // ISSUE #12: links come from the client-side extractor (the server can't see
    // URLs in E2EE conversations), not api.getLinks.
    if (tab === "links") {
      setData(extractLinksFromMessages(messages || []));
      setLoading(false);
      return () => {
        off = true;
      };
    }
    const fn = tab === "files" ? api.getFiles : api.getMembers;
    setLoading(true);
    fn(token, conversation.id)
      .then((d: any) => {
        if (!off) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!off) {
          setData([]);
          setLoading(false);
        }
      });
    return () => {
      off = true;
    };
  }, [tab, token, conversation.id, offlineDemo, messages]);

  if (loading || data === null)
    return (
      <div
        className="tp active"
        style={{ padding: 18, color: "var(--g400)", fontSize: 13 }}
      >
        Loading…
      </div>
    );
  if (offlineDemo || !token)
    return (
      <div
        className="tp active"
        style={{ padding: 18, color: "var(--g400)", fontSize: 13 }}
      >
        The {tab} tab loads from the backend (run with the API connected).
      </div>
    );

  return (
    <div
      className="tp active"
      style={{ overflowY: "auto", padding: "14px 18px" }}
    >
      {tab === "files" &&
        (files.length ? (
          files.map((f: any, i: number) => (
            <button
              key={i}
              type="button"
              title="Download"
              onClick={() => {
                // Same path as the bubble / lightbox download: it decrypts E2EE
                // files with the key merged in above (the old raw fetch saved
                // unreadable ciphertext, which is what made files look broken)
                // and toasts the reason on failure. A file whose key isn't in
                // the loaded messages can't be decrypted here — say so rather
                // than save garbage.
                if (f.e2ee && !f.url && !f._e2eeKey) {
                  window.dispatchEvent(
                    new CustomEvent("colab:toast", {
                      detail: "Scroll to this file in the chat to download it — it's end-to-end encrypted",
                    }),
                  );
                  return;
                }
                void downloadAttachment(f, token, { url: f.url || null }).catch(() => {});
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                border: "none",
                borderBottom: "1px solid var(--g100)",
                background: "transparent",
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                color: "inherit",
              }}
            >
              {/* Always the list thumbnail (image preview or extension avatar) —
                  never the bubble's legacy emoji/colour icon box, even when the
                  stored row still carries `icon`/`color`. */}
              <FileThumb file={f} token={token} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{f.name}</div>
                <div style={{ fontSize: 11, color: "var(--g500)", marginTop: 5 }}>
                  {(typeof f.size === "number" || /^\d+$/.test(String(f.size))) ? humanBytes(Number(f.size)) : f.size || "File"} · {f.by} ·{" "}
                  {f.createdAt ? localTime(f.createdAt) : f.time}
                </div>
              </div>
              <IconDownload size={16} style={{ stroke: "var(--g400)" }} />
            </button>
          ))
        ) : (
          <div style={{ color: "var(--g400)", fontSize: 13 }}>
            No files shared yet.
          </div>
        ))}

      {tab === "links" &&
        (data.length ? (
          data.map((l: any, i: number) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 8,
                transition: "background .15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--g100)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "var(--b50)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  color: "var(--bm)",
                }}
              >
                <IconLink size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--g800)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {(() => {
                    const u = cleanUrl(l.url);
                    try {
                      return new URL(u).hostname;
                    } catch {
                      return u;
                    }
                  })()}
                </div>
                <a
                  href={cleanUrl(l.url)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12,
                    color: "var(--bm)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    marginTop: 2,
                    textDecoration: "none",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.textDecoration = "underline")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.textDecoration = "none")
                  }
                >
                  {cleanUrl(l.url)}
                </a>
                <div
                  style={{ fontSize: 11, color: "var(--g400)", marginTop: 4 }}
                >
                  {l.createdAt ? localTime(l.createdAt) : l.time}
                </div>
              </div>
              <a
                href={(l.url || "").split(/["<]/)[0].trim()}
                target="_blank"
                rel="noreferrer"
                style={{
                  flexShrink: 0,
                  marginTop: 3,
                  display: "flex",
                  color: "var(--g300)",
                  textDecoration: "none",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  style={{
                    width: 14,
                    height: 14,
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                  }}
                >
                  <path d="M7 17l9.2-9.2M17 17V7H7" />
                </svg>
              </a>
            </div>
          ))
        ) : (
          <div
            style={{
              padding: 20,
              textAlign: "center",
              color: "var(--g400)",
              fontSize: 13,
            }}
          >
            No links shared yet.
          </div>
        ))}

      {tab === "members" &&
        (data.length ? (
          data.map((p: any) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                borderBottom: "1px solid var(--g100)",
              }}
            >
              <div className="ca-wrap">
                <Avatar
                  avatar={{
                    kind: "user",
                    initials: p.initials,
                    color: p.color,
                    avatarUrl: p.avatarUrl,
                  }}
                  size={32}
                />
                {p.presence ? (
                  <span className={"sd " + dotClass(p.presence)} />
                ) : null}
              </div>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
                {p.name}
              </div>
              {p.memberRole === "owner" ? (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--g500)",
                    fontWeight: 600,
                  }}
                >
                  Owner
                </span>
              ) : null}
              {p.id !== meId && onSelectPerson ? (
                <button
                  onClick={() => onSelectPerson(p.id)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--g400)",
                    padding: 4,
                    borderRadius: 4,
                    display: "flex",
                  }}
                  title="Message"
                >
                  <IconMessageCircle size={14} />
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--g400)", fontSize: 13 }}>No members.</div>
        ))}
    </div>
  );
}

// ─── ChatView (main) ─────────────────────────────────────────────────────────
