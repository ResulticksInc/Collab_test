"use client";
import React, { useState } from "react";
import Avatar from "../Avatar";
import { IconMessageSquare, IconPhone } from "../../lib/icons";

interface RingingCardProps {
  avatar: any;
  peer: { name: string };
  video?: boolean;
  status: string;
  dir?: string;
  onDecline: (reason?: string) => void;
  onAccept: () => void;
  onCancel: () => void;
  ctlStyle: (active?: boolean, danger?: boolean, success?: boolean) => React.CSSProperties;
}

export default function RingingCard({
  avatar,
  peer,
  video,
  status,
  dir,
  onDecline,
  onAccept,
  onCancel,
  ctlStyle,
}: RingingCardProps) {
  const [quickReply, setQuickReply] = useState(false);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: 320,
          maxWidth: "90vw",
          background: "var(--meet-pop)",
          border: "1px solid var(--meet-pop-line)",
          color: "var(--meet-fg)",
          borderRadius: 18,
          padding: "32px 24px",
          textAlign: "center",
          boxShadow: "0 20px 56px -12px rgba(0,0,0,.4)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 14,
          }}
        >
          <Avatar avatar={avatar} size={72} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{peer.name}</div>
        <div style={{ fontSize: 12.5, color: "var(--meet-sub)", marginTop: 4 }}>
          {(video ? "Video" : "Audio") +
            " · " +
            (status === "ringing" && dir === "in"
              ? `Incoming ${video ? "video" : "audio"} call`
              : "Calling…")}
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 24,
          }}
        >
          {status === "ringing" && dir === "in" ? (
            <>
              <button
                style={ctlStyle(false, true)}
                onClick={() => onDecline()}
                aria-label="Decline call"
                title="Decline call"
              >
                <IconPhone size={20} />
              </button>
              <button
                style={{
                  ...ctlStyle(quickReply, false, false),
                  color: quickReply ? "#fff" : "var(--meet-sub)",
                  background: quickReply
                    ? "color-mix(in srgb, var(--ac) 55%, transparent)"
                    : "var(--meet-btn)",
                }}
                onClick={() => setQuickReply((v) => !v)}
                aria-label="Reply with a message"
                title="Reply with a message"
              >
                <IconMessageSquare size={20} />
              </button>
              <button
                style={ctlStyle(false, false, true)}
                onClick={onAccept}
                aria-label="Accept call"
                title="Accept call"
              >
                <IconPhone size={20} />
              </button>
            </>
          ) : (
            <button
              style={ctlStyle(false, true)}
              onClick={onCancel}
              aria-label="Cancel call"
              title="Cancel call"
            >
              <IconPhone size={20} />
            </button>
          )}
        </div>
        {status === "ringing" && dir === "in" && quickReply ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 18,
            }}
          >
            {[
              "Can't talk right now",
              "In a meeting — call you back",
              "On my way",
              "Please message me instead",
            ].map((msg) => (
              <button
                key={msg}
                onClick={() => onDecline(msg)}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--meet-btn-line)",
                  background: "var(--meet-btn)",
                  color: "var(--meet-fg)",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {msg}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
