import React from "react";
import { IconSparkles, IconSquareCheck } from "../lib/icons";

const FLOW: [string, string][] = [
  [
    "Connect over MCP",
    "Agents reach Collab through the Model Context Protocol — a standard, auditable interface. An agent never gets direct database or network access.",
  ],
  [
    "Act within granted scopes",
    "Each agent operates only inside the permission scopes you grant it. Any request outside those scopes is refused before it runs.",
  ],
  [
    "Everything is audited",
    "Every action an agent takes is written to an append-only audit trail \u2014 enforced at the database level \u2014 attributed to the agent and the exact scope it used.",
  ],
];

const SCOPES: [string, string][] = [
  [
    "Read messages",
    "View conversations and message history it has been granted.",
  ],
  ["Send messages", "Post messages on your behalf in permitted conversations."],
  ["Manage tasks", "Create, assign, complete, and update tasks."],
  ["Read calendar", "See meetings and availability."],
  ["Schedule meetings", "Create and modify meetings on your calendar."],
  ["Read files", "Access files shared in permitted conversations."],
];

const CAPS = [
  {
    t: "Inbox triage",
    s: "Summarize unread threads and surface what needs a reply first.",
  },
  {
    t: "Meeting notes",
    s: "Draft summaries and action items from your calls and meetings.",
  },
  {
    t: "Task automation",
    s: "Create, assign, and update tasks from natural-language requests.",
  },
];

export default function AgentsView() {
  return (
    <div className="view active" id="vagents">
      <div className="agt-hdr">
        <div>
          <h2 className="agt-title">Agents</h2>
          <p className="agt-sub">
            How AI assistants connect to, are governed within, and are audited
            across your workspace
          </p>
        </div>
      </div>
      <div className="agt-body">
        <div className="agt-empty">
          <div className="agt-empty-ic">
            <IconSparkles />
          </div>
          <div className="agt-empty-t">No agents connected</div>
          <div className="agt-empty-s">
            Agents connect AI assistants — over the Model Context Protocol (MCP)
            — to act in your workspace on your behalf. No MCP server is
            configured in this deployment, so there are no agents to show. The
            governance model below is what will apply once one is connected.
          </div>
          <div className="agt-status">
            <span className="agt-status-dot" />
            MCP not configured
          </div>
        </div>

        <div className="agt-grp">
          <div className="agt-grp-h">How it works</div>
          <div className="agt-flow">
            {FLOW.map(([t, s], i) => (
              <div className="agt-step" key={t}>
                <span className="agt-step-n">{i + 1}</span>
                <div className="agt-step-body">
                  <div className="agt-step-t">{t}</div>
                  <div className="agt-step-s">{s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="agt-grp">
          <div className="agt-grp-h">Permission scopes</div>
          <p className="agt-note">
            These scopes define what a connected agent may do. None are active
            until an agent is connected and explicitly granted them.
          </p>
          <div className="agt-scopes">
            {SCOPES.map(([t, s]) => (
              <div className="agt-scope" key={t}>
                <div className="agt-scope-body">
                  <div className="agt-scope-t">{t}</div>
                  <div className="agt-scope-s">{s}</div>
                </div>
                <span className="agt-scope-chip">Not granted</span>
              </div>
            ))}
          </div>
        </div>

        <div className="agt-grp">
          <div className="agt-grp-h">Audit trail</div>
          <div className="agt-audit-empty">
            No agent activity yet. Once an agent is connected, every action it
            takes — messages sent, tasks changed, meetings scheduled — is
            recorded here with a timestamp and the permission scope it used, in
            the same append-only log that already records sign-ins and workspace
            activity. Entries cannot be edited or deleted, even by an
            administrator.
          </div>
        </div>

        <div className="agt-grp">
          <div className="agt-grp-h">What agents will do</div>
          <div className="agt-caps">
            {CAPS.map((c) => (
              <div className="agt-cap" key={c.t}>
                <span className="agt-cap-ic">
                  <IconSquareCheck />
                </span>
                <div className="agt-cap-body">
                  <div className="agt-cap-t">{c.t}</div>
                  <div className="agt-cap-s">{c.s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
