// CoLab render shell — mechanical extraction from CoLabV1.tsx.
// The last statements of CoLabV1 (login/onboarding gates + main return tree),
// rendered with the accumulated session object produced by the useCoLab* hooks.

import dynamic from "next/dynamic";
import Rail from "../Rail";
import { IconX, IconChevronLeft, IconChevronRight, IconMessageCircle, IconSearch, IconMaximize, IconArrowRight } from "../../lib/icons";
import ConversationSidebar from "../ConversationSidebar";
import { createPortal } from "react-dom";
import { useEffect } from "react";
import ChatView from "../ChatView";
import GlobalTooltip from "../GlobalTooltip";
import DesktopUpdateBanner from "../DesktopUpdateBanner";
import UpdateWatcher from "../UpdateWatcher";
import LoginScreen from "../LoginScreen";
import AppSplash from "../AppSplash";
import { MODE_TO_HELP } from "../../lib/helpContent";
import Modal, { Btn } from "../Modal";
import DialogHost from "../DialogHost";
import MediaStudioHost from "../MediaStudioHost";
import type { CallFeedbackPayload } from "../CallFeedback";
import { api } from "../../lib/api";
import { getLastCallReport } from "../../lib/callDiagnostics";
import { log } from "../../lib/logger";
import { EVENTS } from "../../lib/socket";
import config from "../../lib/config";
import { EMPTY_ARR, EMPTY_OBJ, MODULE_HEADERS } from "./helpers";
import DashboardView from "./DashboardView";

// Route & Component level lazy-loading for heavy views, WebRTC engines & modals.
// The loaders of the views a user navigates to from the rail are kept as named
// thunks so they can be PRELOADED (see preloadViewChunks) — the same import()
// resolves to the same chunk, so the first click on a rail entry no longer waits
// for a JS download before the view can even start rendering.
const loadCalendarView = () => import("../CalendarView");
const loadContactsView = () => import("../ContactsView");
const loadOrgAdmin = () => import("../OrgAdmin");
const loadSettings = () => import("../Settings");
const loadCallsView = () => import("./CallsView");
const loadActivityView = () => import("./ActivityView");
const loadSearchView = () => import("../SearchView");
const loadHelpCenter = () => import("../HelpCenter");
const CalendarView = dynamic(loadCalendarView, { ssr: false });
const TasksView = dynamic(() => import("../TasksView"), { ssr: false });
const FilesView = dynamic(() => import("../FilesView"), { ssr: false });
const RemindersView = dynamic(() => import("../RemindersView"), { ssr: false });
const ContactsView = dynamic(loadContactsView, { ssr: false });
const AgentsView = dynamic(() => import("../AgentsView"), { ssr: false });
const OrgAdmin = dynamic(loadOrgAdmin, { ssr: false });
const Settings = dynamic(loadSettings, { ssr: false });
const HelpCenter = dynamic(loadHelpCenter, { ssr: false });
const MeetingRoom = dynamic(() => import("../MeetingRoom"), { ssr: false });
const PreJoinMeeting = dynamic(() => import("../PreJoinMeeting"), { ssr: false });
const CallModal = dynamic(() => import("./CallModal"), { ssr: false });
const CallsView = dynamic(loadCallsView, { ssr: false });
const ActivityView = dynamic(loadActivityView, { ssr: false });
const SearchView = dynamic(loadSearchView, { ssr: false });

// Warm the rail views' chunks in the background once the app is open and the
// main thread is idle. Order = how often people land on them. Each import is a
// cached, content-hashed static asset, so this costs nothing on a revisit and
// never blocks the view that is currently on screen.
let viewChunksPreloaded = false;
function preloadViewChunks() {
  if (viewChunksPreloaded || typeof window === "undefined") return;
  viewChunksPreloaded = true;
  const loaders = [loadCalendarView, loadContactsView, loadActivityView, loadCallsView, loadSettings, loadOrgAdmin, loadSearchView, loadHelpCenter];
  const idle = (fn: () => void) =>
    "requestIdleCallback" in window ? (window as any).requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500);
  idle(() => {
    loaders.forEach((load, i) => setTimeout(() => { load().catch(() => { viewChunksPreloaded = false; }); }, i * 200));
  });
}
const DiagnosticsPanel = dynamic(() => import("../DiagnosticsPanel"), { ssr: false });
const CommandPalette = dynamic(() => import("../CommandPalette"), { ssr: false });
const Onboarding = dynamic(() => import("../Onboarding"), { ssr: false });
const OrgOnboarding = dynamic(() => import("../OrgOnboarding"), { ssr: false });
const MaxDevicesModal = dynamic(() => import("./MaxDevicesModal"), { ssr: false });
const CallFeedback = dynamic(() => import("../CallFeedback"), { ssr: false });

const CreateGroupModal = dynamic(() => import("../Modals").then((m) => m.CreateGroupModal), { ssr: false });
const ManageGroupModal = dynamic(() => import("../Modals").then((m) => m.ManageGroupModal), { ssr: false });
const AddParticipantsModal = dynamic(() => import("../Modals").then((m) => m.AddParticipantsModal), { ssr: false });
const ForwardModal = dynamic(() => import("../Modals").then((m) => m.ForwardModal), { ssr: false });
const BookmarksPanel = dynamic(() => import("../Modals").then((m) => m.BookmarksPanel), { ssr: false });
const InviteModal = dynamic(() => import("../Modals").then((m) => m.InviteModal), { ssr: false });
const NewCallModal = dynamic(() => import("../Modals").then((m) => m.NewCallModal), { ssr: false });

const DeviceHandoffPicker = dynamic(() => import("../DeviceHandoff").then((m) => m.DeviceHandoffPicker), { ssr: false });
const HandoffOfferPrompt = dynamic(() => import("../DeviceHandoff").then((m) => m.HandoffOfferPrompt), { ssr: false });
const MeetingDuplicatePrompt = dynamic(() => import("../DeviceHandoff").then((m) => m.MeetingDuplicatePrompt), { ssr: false });

export type CoLabSessionShell = {
  authResolving: any; authed: any; doLogin: any; doSignup: any;
  loginError: any; loginBusy: any; limitPrompt: any; signOutLoginDevice: any;
  setLimitPrompt: any; e2eeRestoreOpen: any; e2eeRestoreBusy: any; setE2eeRestoreOpen: any;
  setE2eeRestorePw: any; setE2eeRestoreErr: any; doE2eeRestore: any; e2eeRestorePw: any;
  e2eeRestoreErr: any; orgFlowOpen: any; orgCount: any; orgOnboardingSkipped: any;
  tokenRef: any; me: any; setOrgFlowOpen: any; recheckOrgs: any;
  setOrgOnboardingSkipped: any; doLogout: any; showSidebar: any; pane: any;
  isPopout: any; settings: any; cmdkOpen: any; closeCmdk: any;
  conversations: any; users: any; onSelect: any; onSelectPerson: any;
  onMode: any; onRailMode: any; onOpenSettings: any; setModal: any; onboardingOpen: any;
  changeSetting: any; onUpdateProfile: any; setOnboardingOpen: any; mode: any;
  onOpenHelp: any; onRequestLogout: any; totalUnread: any; notifUnread: any;
  notifications: any; isOrgNotif: any; orgNotifClearedRef: any; invites: any;
  taskCount: any; myOpenTaskCount: any; reminderCount: any; openReminderCount: any;
  railCollapsed: any; toggleRailCollapse: any; setMobilePane: any; drafts: any;
  convLoaded: any; activeId: any; filter: any; setFilter: any;
  search: any; onSearch: any; sidebarSearchTick: any; searchResults: any;
  setMode: any; setJumpMsgId: any; onStar: any; onMute: any;
  onConvAction: any; onBulkConvAction: any; onAcceptInvite: any; onDeclineInvite: any;
  gxRef: any; gxQuery: any; setGxQuery: any; setGxOpen: any;
  gxScope: any; lastGxAllNav: any; setSearchSeed: any; gxOpen: any;
  setGxScope: any; setSidebarSearchTick: any; setActiveId: any; activeIdRef: any;
  setHelpTarget: any; helpFromRef: any; modeRef: any; active: any;
  messagesByConv: any; msgLoadStatus: any; loadMessages: any; freqRank: any;
  endedMeetingIds: any; onUpdateConversation: any; onUploadConversationAvatar: any; onUploadAvatar: any;
  onSetMemberRole: any; onRemoveMember: any; onLeaveConversation: any; onManageFromChat: any;
  readState: any; onReply: any; onSend: any; onSendFile: any;
  onSendMedia: any; scheduledByConv: any; onScheduleMessage: any; onRescheduleMessage: any;
  onCancelScheduled: any; huddles: any; activeCall: any; onJoinHuddleFromChat: any;
  onBackToList: any; onReact: any; onBookmark: any; onForwardOpen: any;
  onEditMessage: any; onDeleteMessage: any; showToast: any; onStartCall: any;
  onStartCallFromChat: any; onGlobalSearchScope: any; onAddParticipantsFromChat: any; openBookmarks: any;
  onScheduleMeetingFromChat: any; onJoinMeeting: any; onRejectMeeting: any; onOpenTaskFromChat: any;
  refetchTasks: any; onTyping: any; onDraftChange: any; onCancelUpload: any;
  typingBy: any; connected: any; offlineDemo: any; toggleTheme: any;
  retryMessage: any; onPin: any; onUnpin: any; onMarkImportant: any;
  loadEarlierMessages: any; blockedIds: any; onBlockUser: any; onUnblockUser: any;
  onReportUser: any; jumpMsgId: any; searchSeed: any; onGlobalSearch: any;
  setOpenTaskId: any; setFocusReminderId: any; setFocusMeetingId: any; helpTarget: any;
  goBack: any; orgTab: any; onLeftOrg: any; saveStatus: any;
  files: any; onUploadFile: any; onDeleteFile: any; onRestoreFile: any;
  onDownloadFile: any; onToggleStarFile: any; refetchFiles: any; fileCount: any;
  fileHasMore: any; fileLoadingMore: any; fileLoading: any; loadMoreFiles: any;
  fileTab: any; fileChangeTick: any; openFileId: any; setOpenFileId: any;
  meetings: any; sortByFreq: any; onCreateMeeting: any; onPreviewOccurrences?: any; onCheckAvailability?: any; onMeetingPreview?: any; onUpdateMeeting: any; onInviteMeeting?: any;
  onDeleteMeeting: any; onLeaveMeeting: any; onCompleteMeeting: any; meetingTitle: any;
  meetingAttendees: any; setMeetingTitle: any; setMeetingAttendees: any; focusMeetingId: any;
  calls: any; voicemails: any; onMarkActivityRead: any; onSetReadConversation: any;
  setNotifications: any; setNotifUnread: any; frequentUsers: any; callsSeenAt: any;
  tasks: any; setCallsScope: any; onCreateTask: any; onMoveTask: any;
  onUpdateTask: any; onDeleteTask: any; onBulkTasks: any; onSetAssignees: any;
  onWatchTask: any; taskTick: any; openTaskId: any; taskHasMore: any;
  taskLoadingMore: any; loadMoreTasks: any; taskConflict: any; setTaskConflict: any;
  taskProjects: any; taskViews: any; taskProjectFilter: any; onProjectFilter: any;
  onCreateProject: any; onUpdateProject: any; onDeleteProject: any; onSaveView: any;
  onUpdateView: any; onDeleteView: any; reminders: any; folders: any;
  reminderCounts: any; reminderHasMore: any; reminderLoadingMore: any; loadMoreReminders: any;
  onAddReminder: any; onQuickAddReminder: any; onToggleReminder: any; onDeleteReminder: any;
  onPatchReminder: any; onSetReminderStatus: any; onSnoozeReminder: any; onCreateFolder: any;
  onRenameFolder: any; onDeleteFolder: any; onBulkReminders: any; focusReminderId: any;
  onSendInvite: any; onCancelInvite: any; onLoadOlderCalls: any; callsScope: any;
  presentingNow: any; callPip: any; setCallPip: any; onTempGroupCreated: any;
  openMoveDevice: any; openComms: any; commsUnread: any; socketRef: any;
  onAcceptCall: any; onDeclineCall: any; onCancelCall: any; onHangup: any;
  onAddToCall: any; iStartedCall: any; roomState: any; onLeaveRoom: any;
  joinPrefsRef: any; commsOpen: any; commsConvId: any; commsConv: any;
  commsResizeHandle: any; setCommsConvId: any; setCommsOpen: any; commsJumpMsgId: any;
  setCommsJumpMsgId: any; onCloseComms: any; onCommsSelect: any; commsFilter: any;
  setCommsFilter: any; onCommsSelectPerson: any; onCommsSelectMessage: any; onOpenCreateGroup: any;
  onOpenCreateChannel: any; onCommsNewDm: any; moveDeviceFor: any; setMoveDeviceFor: any;
  handoffOffer: any; acceptHandoff: any; declineHandoff: any; meetingDup: any;
  dupHandledRef: any; setMeetingDup: any; feedbackMeta: any; setFeedbackMeta: any;
  settingsRef: any; changeSettingRef: any; modal: any; doCreate: any;
  refetchConversations: any; doAddParticipants: any; doForward: any; logoutOpen: any;
  setLogoutOpen: any; shortcutsOpen: any; setShortcutsOpen: any; manageConvId: any;
  setManageConvId: any; preJoin: any; setPreJoin: any; enterMeetingNow: any;
  inviteOpen: any; setInviteOpen: any; onInviteSubmit: any; toast: any;
};

// Host-gated public (guest) meeting-link calls, handed to the calendar so it can
// show "Create / Copy / Turn off public link" without owning an API token.
const publicLinkFor = (tokenRef: any) => ({
  get: (id: string) => api.getMeetingPublicLink(tokenRef.current, id),
  create: (id: string) => api.createMeetingPublicLink(tokenRef.current, id),
  revoke: (id: string) => api.revokeMeetingPublicLink(tokenRef.current, id),
});

export default function CoLabShell({ s }: { s: CoLabSessionShell }) {
  const {
    authResolving, authed, doLogin, doSignup,
    loginError, loginBusy, limitPrompt, signOutLoginDevice,
    setLimitPrompt, e2eeRestoreOpen, e2eeRestoreBusy, setE2eeRestoreOpen,
    setE2eeRestorePw, setE2eeRestoreErr, doE2eeRestore, e2eeRestorePw,
    e2eeRestoreErr, orgFlowOpen, orgCount, orgOnboardingSkipped,
    tokenRef, me, setOrgFlowOpen, recheckOrgs,
    setOrgOnboardingSkipped, doLogout, showSidebar, pane,
    isPopout, settings, cmdkOpen, closeCmdk,
    conversations, users, onSelect, onSelectPerson,
    onMode, onRailMode, onOpenSettings, setModal, onboardingOpen,
    changeSetting, onUpdateProfile, setOnboardingOpen, mode,
    onOpenHelp, onRequestLogout, totalUnread, notifUnread,
    notifications, isOrgNotif, orgNotifClearedRef, invites,
    taskCount, myOpenTaskCount, reminderCount, openReminderCount,
    railCollapsed, toggleRailCollapse, setMobilePane, drafts,
    convLoaded, activeId, filter, setFilter,
    search, onSearch, sidebarSearchTick, searchResults,
    setMode, setJumpMsgId, onStar, onMute,
    onConvAction, onBulkConvAction, onAcceptInvite, onDeclineInvite,
    gxRef, gxQuery, setGxQuery, setGxOpen,
    gxScope, lastGxAllNav, setSearchSeed, gxOpen,
    setGxScope, setSidebarSearchTick, setActiveId, activeIdRef,
    setHelpTarget, helpFromRef, modeRef, active,
    messagesByConv, msgLoadStatus, loadMessages, freqRank,
    endedMeetingIds, onUpdateConversation, onUploadConversationAvatar, onUploadAvatar,
    onSetMemberRole, onRemoveMember, onLeaveConversation, onManageFromChat,
    readState, onReply, onSend, onSendFile,
    onSendMedia, scheduledByConv, onScheduleMessage, onRescheduleMessage,
    onCancelScheduled, huddles, activeCall, onJoinHuddleFromChat,
    onBackToList, onReact, onBookmark, onForwardOpen,
    onEditMessage, onDeleteMessage, showToast, onStartCall,
    onStartCallFromChat, onGlobalSearchScope, onAddParticipantsFromChat, openBookmarks,
    onScheduleMeetingFromChat, onJoinMeeting, onRejectMeeting, onOpenTaskFromChat,
    refetchTasks, onTyping, onDraftChange, onCancelUpload,
    typingBy, connected, offlineDemo, toggleTheme,
    retryMessage, onPin, onUnpin, onMarkImportant,
    loadEarlierMessages, blockedIds, onBlockUser, onUnblockUser,
    onReportUser, jumpMsgId, searchSeed, onGlobalSearch,
    setOpenTaskId, setFocusReminderId, setFocusMeetingId, helpTarget,
    goBack, orgTab, onLeftOrg, saveStatus,
    files, onUploadFile, onDeleteFile, onRestoreFile,
    onDownloadFile, onToggleStarFile, refetchFiles, fileCount,
    fileHasMore, fileLoadingMore, fileLoading, loadMoreFiles,
    fileTab, fileChangeTick, openFileId, setOpenFileId,
    meetings, sortByFreq, onCreateMeeting, onPreviewOccurrences, onCheckAvailability, onMeetingPreview, onUpdateMeeting, onInviteMeeting,
    onDeleteMeeting, onLeaveMeeting, onCompleteMeeting, meetingTitle,
    meetingAttendees, setMeetingTitle, setMeetingAttendees, focusMeetingId,
    calls, voicemails, onMarkActivityRead, onSetReadConversation,
    setNotifications, setNotifUnread, frequentUsers, callsSeenAt,
    tasks, setCallsScope, onCreateTask, onMoveTask,
    onUpdateTask, onDeleteTask, onBulkTasks, onSetAssignees,
    onWatchTask, taskTick, openTaskId, taskHasMore,
    taskLoadingMore, loadMoreTasks, taskConflict, setTaskConflict,
    taskProjects, taskViews, taskProjectFilter, onProjectFilter,
    onCreateProject, onUpdateProject, onDeleteProject, onSaveView,
    onUpdateView, onDeleteView, reminders, folders,
    reminderCounts, reminderHasMore, reminderLoadingMore, loadMoreReminders,
    onAddReminder, onQuickAddReminder, onToggleReminder, onDeleteReminder,
    onPatchReminder, onSetReminderStatus, onSnoozeReminder, onCreateFolder,
    onRenameFolder, onDeleteFolder, onBulkReminders, focusReminderId,
    onSendInvite, onCancelInvite, onLoadOlderCalls, callsScope,
    presentingNow, callPip, setCallPip, onTempGroupCreated,
    openMoveDevice, openComms, commsUnread, socketRef,
    onAcceptCall, onDeclineCall, onCancelCall, onHangup,
    onAddToCall, iStartedCall, roomState, onLeaveRoom,
    joinPrefsRef, commsOpen, commsConvId, commsConv,
    commsResizeHandle, setCommsConvId, setCommsOpen, commsJumpMsgId,
    setCommsJumpMsgId, onCloseComms, onCommsSelect, commsFilter,
    setCommsFilter, onCommsSelectPerson, onCommsSelectMessage, onOpenCreateGroup,
    onOpenCreateChannel, onCommsNewDm, moveDeviceFor, setMoveDeviceFor,
    handoffOffer, acceptHandoff, declineHandoff, meetingDup,
    dupHandledRef, setMeetingDup, feedbackMeta, setFeedbackMeta,
    settingsRef, changeSettingRef, modal, doCreate,
    refetchConversations, doAddParticipants, doForward, logoutOpen,
    setLogoutOpen, shortcutsOpen, setShortcutsOpen, manageConvId,
    setManageConvId, preJoin, setPreJoin, enterMeetingNow,
    inviteOpen, setInviteOpen, onInviteSubmit, toast
  } = s;
  // Preload the rail views' code once signed in (no-op before auth / on revisit).
  useEffect(() => {
    if (authed) preloadViewChunks();
  }, [authed]);

  // ---- CoLabV1.tsx statements 467–470 ----
  if (authResolving) return <AppSplash />;
  if (!authed)
    return (
      <>
        <LoginScreen
          onLogin={doLogin}
          onSignup={doSignup}
          error={loginError}
          busy={loginBusy}
        />
        {limitPrompt &&
          createPortal(
            <MaxDevicesModal
              prompt={limitPrompt}
              busy={loginBusy}
              onSignOutDevice={(sid: string) => signOutLoginDevice(sid)}
              onContinue={() =>
                doLogin(limitPrompt.email, limitPrompt.password, limitPrompt.remember)
              }
              onCancel={() => setLimitPrompt(null)}
            />,
            document.body,
          )}
        {e2eeRestoreOpen &&
          createPortal(
            <Modal
              title="Unlock your message history"
              zIndex={2200}
              onClose={() => {
                if (!e2eeRestoreBusy) {
                  setE2eeRestoreOpen(false);
                  setE2eeRestorePw("");
                  setE2eeRestoreErr(null);
                }
              }}
              footer={
                <>
                  <Btn
                    onClick={() => {
                      setE2eeRestoreOpen(false);
                      setE2eeRestorePw("");
                      setE2eeRestoreErr(null);
                    }}
                    disabled={e2eeRestoreBusy}
                  >
                    Not now
                  </Btn>
                  <Btn
                    primary
                    onClick={doE2eeRestore}
                    disabled={e2eeRestoreBusy || !e2eeRestorePw.trim()}
                  >
                    {e2eeRestoreBusy ? "Restoring…" : "Restore"}
                  </Btn>
                </>
              }
            >
              <div style={{ fontSize: 13, color: "var(--g700)", lineHeight: 1.5 }}>
                Your encrypted message history is backed up, but this device signed in
                without a password and none of your other devices are online to hand it
                over. Enter your sign-in password once to unlock the backup — every
                message, photo, file and voice note is restored here, and this device
                stays unlocked from now on.
              </div>
              <input
                type="password"
                autoFocus
                placeholder="Your password"
                value={e2eeRestorePw}
                onChange={(e) => setE2eeRestorePw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e2eeRestorePw.trim() && !e2eeRestoreBusy)
                    doE2eeRestore();
                }}
                style={{
                  width: "100%",
                  padding: "11px 13px",
                  borderRadius: 10,
                  border: "1px solid var(--g200)",
                  fontSize: 13,
                  background: "var(--sb)",
                  color: "var(--g900)",
                  outline: "none",
                  boxSizing: "border-box",
                  marginTop: 14,
                }}
              />
              {e2eeRestoreErr && (
                <div style={{ color: "#d33", fontSize: 13, marginTop: 10 }}>{e2eeRestoreErr}</div>
              )}
            </Modal>,
            document.body,
          )}
      </>
    );
  if (authed && (orgFlowOpen || (orgCount === 0 && !orgOnboardingSkipped)))
    return (
      <OrgOnboarding
        token={tokenRef.current as string}
        me={me}
        onEntered={async (enteredOrgId?: string) => {
          setOrgFlowOpen(false);
          // Entering / rejoining an org must fully re-hydrate the shell ON that
          // org — membership, permissions, cached data, the conversation list,
          // unread counts and the chat socket ALL initialize in boot hydration,
          // which is keyed on `authed` (unchanged here) and so never re-fires on
          // this in-place onboarding→shell transition. That is why the Chat
          // sidebar stayed empty after a rejoin until another module happened to
          // refetch. Pivot the session to the entered org and reload — exactly
          // like every other org switch (OrgSwitcher / onLeftOrg / onOrgInvalid)
          // — so the whole shell re-initializes cleanly with no stale state and
          // no duplicate socket subscriptions.
          if (enteredOrgId) {
            try { await api.switchOrg(tokenRef.current as string, enteredOrgId); } catch (_) { }
          }
          if (typeof window !== "undefined") window.location.reload();
          else recheckOrgs(); // no window (SSR) — at least reflect the new membership
        }}
        onSkip={() => {
          try { window.localStorage.setItem("colab.orgOnboardingSkipped", "1"); } catch { }
          setOrgOnboardingSkipped(true);
          setOrgFlowOpen(false);
        }}
        onSignOut={doLogout}
      />
    );
  return (
    <div
      id="app"
      className={
        (showSidebar ? "" : "hide-sidebar") +
        " pane-" +
        pane +
        (isPopout ? " popout" : "")
      }
    >
      {/* One-shot reveal curtain: covers the heavy first render after login and
          fades out smoothly (plays once on mount; harmless thereafter). */}
      <div className="app-curtain" aria-hidden="true" />
      {/* Always-mounted diagnostics: captures server/realtime/app events, shows a
          floating alert on errors, and opens a plain-English status panel
          (Ctrl+Alt+D / ?diag=1 / window.__colabDiag()). */}
      <DiagnosticsPanel enabled={settings?.diagFloating === true} />
      {/* Cmd/Ctrl+K quick switcher — purely presentational: reads existing state
          and invokes existing handlers (onSelect/onSelectPerson/onMode/…). */}
      <CommandPalette
        open={cmdkOpen}
        onClose={closeCmdk}
        conversations={conversations}
        people={users}
        meId={me && me.id}
        onSelect={onSelect}
        onSelectPerson={onSelectPerson}
        onMode={onMode}
        onOpenSettings={onOpenSettings}
        onNewMessage={() => setModal({ type: "newMessage" })}
      />
      {onboardingOpen ? (
        <Onboarding
          settings={settings}
          me={me}
          token={tokenRef.current}
          onChangeSetting={changeSetting}
          onUpdateProfile={onUpdateProfile}
          onFinish={() => {
            changeSetting("onboardingDone", true);
            setOnboardingOpen(false);
          }}
          onContinueLater={() => {
            changeSetting("onboardingDone", true);
            setOnboardingOpen(false);
          }}
        />
      ) : null}
      <Rail
        mode={mode}
        onMode={onRailMode}
        token={tokenRef.current}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
        diagEnabled={settings?.diagFloating === true}
        onLogout={onRequestLogout}
        unread={totalUnread}
        notifUnread={notifUnread}
        orgNotifUnread={
          // BA #5: unread org-scoped notifications (role changes, broadcasts,
          // approvals/removals involving you) → dot on the org toggle. Cleared
          // by reading them in Activity OR by opening the Organization module
          // (see the effect above) — so the dot means a REAL unseen update.
          // Mirror the clear-effect's exclusions so the dot can't get STUCK: a
          // notification with no id can't be marked read (permanent phantom dot),
          // and one the user already cleared by opening the org must stay cleared
          // even if a later poll / NOTIFICATION_COUNT reverts its isRead flag.
          (notifications || []).filter(
            (n) =>
              !n.isRead &&
              isOrgNotif(n) &&
              n.id != null &&
              !orgNotifClearedRef.current.has(String(n.id)),
          ).length
        }
        requestCount={
          (invites || []).filter(
            (i) => i.direction === "incoming" && i.status === "pending",
          ).length
        }
        taskCount={myOpenTaskCount}
        reminderCount={openReminderCount}
        me={me}
        collapsed={railCollapsed}
        onToggleCollapse={toggleRailCollapse}
        presence={settings.manualPresence || "auto"}
        statusMessage={settings.statusMessage || ""}
        onPresenceChange={(v) => changeSetting("manualPresence", v)}
        onStatusMessageChange={(v) => changeSetting("statusMessage", v)}
        onUpdateName={(name) => onUpdateProfile({ name })}
      />
      <button
        id="sb-expand"
        data-tip="Expand sidebar"
        onClick={() => {
          // The list is hidden by TWO mechanisms: the imperative `sb-collapsed`
          // body class (desktop) AND the responsive `pane-chat` state (which sets
          // `#app.pane-chat #sidebar { display:none }` at ≤768px). Removing only
          // the class left the pane rule hiding the list, forcing the user to
          // leave and re-enter Messages. Reverse BOTH so expand works in place.
          document.body.classList.remove("sb-collapsed");
          setMobilePane("list");
        }}
      >
        <IconChevronRight size={16} />
      </button>
      {showSidebar ? (
        <ConversationSidebar
          conversations={conversations}
          drafts={drafts}
          selfPresence={settings.manualPresence || "auto"}
          loading={!convLoaded}
          activeId={activeId}
          onSelect={onSelect}
          filter={filter}
          onFilter={setFilter}
          search={search}
          onSearch={onSearch}
          openSearchTick={sidebarSearchTick}
          searchResults={searchResults}
          onSelectPerson={onSelectPerson}
          onSelectMessage={(convId: string, msgId: string) => {
            // Search → message result: open the conversation AND jump+flash the
            // exact message (reuses the notification deep-link infra).
            onSelect(convId);
            setMode("chats");
            if (msgId) setJumpMsgId(msgId);
          }}
          onStar={onStar}
          onMute={onMute}
          onConvAction={onConvAction}
          onBulkConvAction={onBulkConvAction}
          onCreateGroup={() => setModal({ type: "createGroup" })}
          onCreateChannel={() => setModal({ type: "createChannel" })}
          onNewDm={() => onMode("contacts")}
          workspaceName={config.workspaceName}
          sidebarWidth={Number(settings.sidebarWidth) || 348}
          onResize={(w) => changeSetting("sidebarWidth", w)}
          invites={invites}
          onAcceptInvite={onAcceptInvite}
          onDeclineInvite={onDeclineInvite}
        />
      ) : null}
      <div id="main">
        {mode !== "dashboard" ? (
          // BA/CEO #30: in the chat module the global search is removed and (on
          // web) the whole top bar collapses so the message view extends up. On
          // desktop the bar stays for the window controls, just without search.
          <div
            className={"gx-topbar" + (mode === "chats" ? " gx-topbar--chats" : "")}
          >
            <div className="gx-topbar-side gx-topbar-left">
              {/* Standardized page header: title (+ optional subtitle) on the left
                  of the shared top bar, so every module shows title-left /
                  search-right on ONE row instead of a wasted title row below. */}
              {MODULE_HEADERS[mode] ? (
                <div className="gx-hdr">
                  <h1 className="gx-hdr-title">{MODULE_HEADERS[mode].title}</h1>
                  {MODULE_HEADERS[mode].subtitle ? (
                    <p className="gx-hdr-sub">{MODULE_HEADERS[mode].subtitle}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            {/* Calls actions (Audio / Video / Schedule) used to live here in the
                top bar; they now sit on the Calls list header row alongside the
                All / Missed / Dialled scope toggle (see CallsView), so the Calls
                top bar is title-left / search-right exactly like every other
                module. */}
            {/* Teams-style global search: centred, with a per-module scope menu.
                HIDDEN in the chat module (mode==="chats") — the Chat View owns its
                own inline Global Search, expanded from the header Search icon, so
                there's no permanent search bar reserving space above the chat.
                Also hidden on the dedicated Search page (SearchView owns search)
                and on Organization, an admin console where a global message
                search bar would be noise (it shows its own title instead). */}
            {mode !== "search" && mode !== "chats" && mode !== "org" && mode !== "whatsapp" && (
              <div
                className={"gx-search" + (["calendar", "calls", "contacts", "activity"].includes(mode) ? " gx-collapsible" : "") + (gxOpen ? " gx-open" : "")}
                ref={gxRef}
                onClick={(e) => {
                  // Calendar: the search is collapsed to an icon — clicking it opens the field.
                  if (["calendar", "calls", "contacts", "activity"].includes(mode)) {
                    const i = (e.currentTarget as HTMLElement).querySelector("input");
                    if (i && document.activeElement !== i) i.focus();
                  }
                }}
              >
                <IconSearch className="gx-search-ico" />
                <input
                  className="gx-search-input"
                  value={gxQuery}
                  onChange={(e) => setGxQuery(e.target.value)}
                  onFocus={() => setGxOpen(true)}
                  // Re-open the scope selector on ANY click in the input, not just
                  // focus: after picking a scope the menu closes but the input keeps
                  // focus, so onFocus never re-fires — clicking it again must still
                  // re-show the chips (without clearing the query or closing search).
                  onClick={() => setGxOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && gxQuery.trim() && gxScope === "all") {
                      e.preventDefault();
                      setGxOpen(false);
                      lastGxAllNav.current = gxQuery.trim();
                      setSearchSeed(gxQuery);
                      setMode("search");
                    }
                  }}
                  placeholder={mode === "calls" ? "Search calls, people..." : "Search"}
                  aria-label="Global search"
                />
                {mode === "calls" && gxQuery ? (
                  <button
                    type="button"
                    className="gx-search-clear"
                    aria-label="Clear search"
                    onClick={() => setGxQuery("")}
                  >
                    ×
                  </button>
                ) : null}
                {/* Round gradient arrow — the same affordance as the dashboard and
                  Search page bars. Runs the "All" search, like Enter. */}

                {gxOpen && (
                  <div className="gx-menu" role="menu">
                    <div className="gx-menu-head">Search in</div>
                    <div className="gx-chips">
                      {(
                        [
                          ["all", "All"],
                          ["chats", "Chat"],
                          ["calls", "Calls"],
                          ["activity", "Activity"],
                          ["contacts", "Contacts"],
                          ["calendar", "Calendar"],
                          ["help", "Help"],
                          // ISSUE #15: Tasks / Reminders / Files scopes hidden
                          // while those modules are hidden from the nav.
                        ] as [string, string][]
                      ).map(([k, label]) => (
                        <button
                          key={k}
                          type="button"
                          className={"gx-chip" + (gxScope === k ? " active" : "")}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setGxScope(k);
                            setGxOpen(false);
                            // "All" opens the aggregate Search page. Every other
                            // chip NAVIGATES to / filters its own module rather than
                            // dumping the user on the empty Search page.
                            if (k === "all") {
                              setSearchSeed(gxQuery);
                              setMode("search");
                            } else if (k === "chats") {
                              // "Chat" from another module → open the Messaging module
                              // and LAND IN the DM-sidebar search (reveal it + seed the
                              // query), rather than the aggregate Search page.
                              setMode("chats");
                              onSearch(gxQuery);
                              setSidebarSearchTick((t) => t + 1);
                              // Do NOT carry the previously-active thread over: clear it
                              // so the main window shows the "Select a conversation"
                              // placeholder (ChatView's <Welcome/>) while the user picks
                              // a result from the seeded sidebar search.
                              setActiveId(null);
                              activeIdRef.current = null;
                            } else if (k === "help") {
                              // Help behaves like the other module chips — it OPENS
                              // Help, it doesn't dump the user on the generic search
                              // page. With a query, show matching help topics in the
                              // aggregate Search (scoped to Help so nothing else is
                              // mixed in); with no query there is nothing to search,
                              // so open the Help Center to browse.
                              if (gxQuery.trim()) {
                                setSearchSeed(gxQuery);
                                setMode("search");
                              } else {
                                // Context-aware browse: open Help to the article for
                                // the module you're on (same as the Rail Help entry).
                                setHelpTarget("");
                                helpFromRef.current = modeRef.current;
                                setMode("help");
                              }
                            } else setMode(k);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div
                      className="gx-menu-hint"
                      style={{
                        // No own padding — the .gx-menu 16px inset + 12px gap own the
                        // spacing, so the helper keeps full breathing room from the
                        // panel's bottom edge (was cramped at 2px).
                        margin: 0,
                        fontSize: 11.5,
                        color: "var(--g500, #6b7280)",
                        lineHeight: 1.4,
                      }}
                    >
                      {gxScope === "chats"
                        ? "Searches messages, chats & files."
                        : gxScope === "all"
                          ? "Searches everything across the app."
                          : "Filters the selected module by your query."}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div id={mode === "calendar" ? "cal-header-slot" : undefined} className="gx-topbar-side gx-topbar-right" />
            {/* Desktop only: carve a no-drag rectangle under the window-control
                pills. This bar is a -webkit-app-region:drag surface; the pills
                live in a separate subtree (<DesktopChrome>) so their no-drag
                can't carve out of it — without this, clicks on the pills are
                swallowed as title-bar drags on every non-dashboard module. */}
            <div className="gx-topbar-winspace" aria-hidden />
          </div>
        ) : null}
        {mode === "chats" ? (
          <ChatView
            // ChatView early-returns <Welcome/> when there's no conversation,
            // which sits ABOVE some of its hooks. Toggling between the empty
            // state and a real conversation would change the hook count and
            // crash ("Rendered more hooks…"). Keying by presence-of-conversation
            // remounts cleanly across that boundary, while conversation↔
            // conversation switches keep the same instance (same key="cv").
            key={active ? "cv" : "empty"}
            conversation={active}
            messages={(active && messagesByConv[active.id]) || EMPTY_ARR}
            msgLoadStatus={active ? msgLoadStatus[active.id] : undefined}
            onRetryLoad={() => {
              if (active) loadMessages(active.id, true);
            }}
            token={tokenRef.current}
            meId={me && me.id}
            freqRank={freqRank}
            endedMeetingIds={endedMeetingIds}
            onUpdateConversation={onUpdateConversation}
            onUploadConversationAvatar={onUploadConversationAvatar}
            me={me}
            onUpdateProfile={onUpdateProfile}
            onOpenSettings={onOpenSettings}
            onUploadAvatar={onUploadAvatar}
            onSetMemberRole={onSetMemberRole}
            onRemoveMember={onRemoveMember}
            onLeaveConversation={onLeaveConversation}
            onManageConversation={onManageFromChat}
            readReceipts={(active && readState[active.id]) || EMPTY_OBJ}
            showReceipts={settings.readReceipts !== false}
            showLastSeen={settings.lastSeen !== false}
            grouping={settings.messageGrouping !== false}
            linkPreview={settings.linkPreview !== false}
            timeFormat={settings.timeFormat || "12h"}
            linkConfirm={settings.linkConfirm === true}
            sendTyping={settings.sendTyping !== false}
            onReply={onReply}
            onSend={onSend}
            onSendFile={onSendFile}
            onSendMedia={onSendMedia}
            scheduled={(active && scheduledByConv[active.id]) || EMPTY_ARR}
            onSchedule={onScheduleMessage}
            onReschedule={onRescheduleMessage}
            onCancelScheduled={onCancelScheduled}
            enterToSend={settings.enterToSend}
            newestAtTop={settings.newestAtTop === true}
            huddle={active ? huddles[active.id] : null}
            inHuddle={
              !!(
                activeCall &&
                activeCall.conversationId === (active && active.id)
              )
            }
            onJoinHuddle={onJoinHuddleFromChat}
            onBack={onBackToList}
            onReact={onReact}
            onBookmark={onBookmark}
            onForward={onForwardOpen}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            showToast={showToast}
            onStartCall={onStartCallFromChat}
            onGlobalSearchScope={onGlobalSearchScope}
            onAddParticipants={onAddParticipantsFromChat}
            onMute={onMute}
            onOpenBookmarks={openBookmarks}
            onSelectPerson={onSelectPerson}
            onCallUser={(person: any, video: boolean) => {
              // Prefer the Contacts row; fall back to a synthetic peer from the
              // card identity so the call still starts for a non-contact author
              // (mirrors onStartCallFromChat).
              const peer =
                users.find((u) => u.id === person.id) || {
                  id: person.id,
                  name: person.name,
                  initials: person.initials || "?",
                  color: person.color || "#4f46e5",
                  avatarUrl: person.avatarUrl,
                };
              if (peer && peer.id) onStartCall(peer, video);
            }}
            onScheduleMeeting={onScheduleMeetingFromChat}
            onJoinMeeting={onJoinMeeting}
            onRejectMeeting={onRejectMeeting}
            onOpenTask={onOpenTaskFromChat}
            onTaskCreated={refetchTasks}
            onTyping={onTyping}
            onDraftChange={onDraftChange}
            onCancelUpload={onCancelUpload}
            typingUserId={active ? typingBy[active.id] : null}
            connected={connected}
            offlineDemo={offlineDemo}
            onToggleTheme={toggleTheme}
            onRetry={retryMessage}
            unreadCount={active ? active.unread || active.unreadAtOpen || 0 : 0}
            people={users}
            presence={settings.manualPresence || "auto"}
            statusMessage={settings.statusMessage || ""}
            onPresenceChange={(v) => changeSetting("manualPresence", v)}
            onStatusMessageChange={(v) => changeSetting("statusMessage", v)}
            onPin={onPin}
            onUnpin={onUnpin}
            onMarkImportant={onMarkImportant}
            onLoadEarlier={loadEarlierMessages}
            peerBlocked={(() => {
              if (!active || active.kind !== "dm") return false;
              const pid = (active.members || []).find(
                (m: string) => m !== (me && me.id),
              );
              return !!(pid && blockedIds.has(pid));
            })()}
            pendingConnection={!!(active && active.kind === "dm" && (active as any).pendingConnection && active.createdBy === (me && me.id))}
            pendingRequestInvite={(() => {
              // RECIPIENT side of a pending connection DM: they see the sender's
              // message request and Accept/Decline it in-chat. Find their incoming
              // pending invite from the DM's peer.
              if (!active || active.kind !== "dm" || !(active as any).pendingConnection)
                return null;
              if (active.createdBy === (me && me.id)) return null; // sender side
              const peer = (active.members || []).find(
                (m: string) => m !== (me && me.id),
              );
              return (
                (invites || []).find(
                  (i: any) =>
                    i.direction === "incoming" &&
                    i.status === "pending" &&
                    i.from &&
                    i.from.id === peer,
                ) || null
              );
            })()}
            onAcceptRequest={onAcceptInvite}
            onDeclineRequest={onDeclineInvite}
            onBlockUser={onBlockUser}
            onUnblockUser={onUnblockUser}
            onReportUser={onReportUser}
            jumpToMessageId={jumpMsgId}
            onJumped={() => setJumpMsgId(null)}
          />
        ) : mode === "search" ? (
          <SearchView
            key={searchSeed}
            seed={searchSeed}
            seedScope="all"
            // "Chat" scope: restrict to messages + chats + files, never users
            // (users are found via the conversation-sidebar search).
            only={
              gxScope === "chats"
                ? ["conversations", "messages", "files"]
                : gxScope === "help"
                  ? ["help"]
                  : undefined
            }
            onSearch={onGlobalSearch}
            onGoMode={(m, id) => {
              onMode(m);
              // AUDIT #33: a search hit must DEEP-LINK to the matched item, not
              // just switch to the list. Forward the id into each module's
              // existing focus/open mechanism so it opens that item's detail
              // (and flashes/scrolls to its row) on arrival.
              if (id) {
                if (m === "tasks") setOpenTaskId(id);
                else if (m === "reminders") setFocusReminderId(id);
                else if (m === "calendar") setFocusMeetingId(id);
              }
            }}
            onJoin={onJoinMeeting}
            onToast={showToast}
            onOpenConversation={(id, msgId) => {
              onSelect(id);
              onMode("chats");
              setJumpMsgId(msgId || null);
            }}
            onOpenPerson={(id) => {
              setFilter("all");
              onSelectPerson(id);
              onMode("chats");
            }}
            onOpenHelp={(moduleId) => {
              setHelpTarget(moduleId || "");
              helpFromRef.current = modeRef.current;
              onMode("help");
            }}
          />
        ) : mode === "agents" ? (
          <AgentsView />
        ) : mode === "help" ? (
          <HelpCenter
            initialModuleId={
              helpTarget ||
              MODE_TO_HELP[helpFromRef.current] ||
              "messaging"
            }
            onClose={goBack}
          />
        ) : mode === "org" ? (
          // BA #7: Organization is a first-class routed module (opened from the
          // Rail's org switcher), NOT an overlay — so switching modules unmounts
          // it and the top bar / history stay in sync. Mirrors Settings + Help.
          <OrgAdmin
            token={tokenRef.current}
            initialTab={orgTab}
            onLeftOrg={onLeftOrg}
            onClose={() => {
              // Leaving the console refreshes the Rail switcher (org name, role,
              // pending-request badge) — the panel used to own that reload when
              // it was a modal; the existing org-notif event is the seam for it.
              try {
                window.dispatchEvent(new Event("colab:org-notif"));
              } catch (_) { }
              goBack();
            }}
          />
        ) : mode === "settings" ? (
          <Settings
            settings={settings}
            onChange={changeSetting}
            onClose={goBack}
            token={tokenRef.current}
            saveStatus={saveStatus}
            me={me}
            onUploadAvatar={onUploadAvatar}
            onUpdateProfile={onUpdateProfile}
            onReopenOnboarding={() => {
              setMode("dashboard");
              setOnboardingOpen(true);
            }}
          />
        ) : mode === "files" ? (
          <FilesView
            externalSearch={gxScope === "files" ? gxQuery : ""}
            files={files}
            onUpload={onUploadFile}
            onDelete={onDeleteFile}
            onRestore={onRestoreFile}
            onDownload={onDownloadFile}
            onToggleStar={onToggleStarFile}
            token={tokenRef.current}
            users={users}
            conversations={conversations}
            onRefresh={refetchFiles}
            totalCount={fileCount}
            hasMore={fileHasMore}
            loadingMore={fileLoadingMore}
            loading={fileLoading}
            onLoadMore={loadMoreFiles}
            activeTab={fileTab}
            onTabChange={(t, s) =>
              refetchFiles(s === undefined ? { tab: t } : { tab: t, search: s })
            }
            onSearch={(s) => refetchFiles({ search: s })}
            listDeleted={(opts) => api.listDeletedFiles(tokenRef.current, opts)}
            fileChangeTick={fileChangeTick}
            openFileId={openFileId}
            onOpenedFile={() => setOpenFileId(null)}
            onToast={showToast}
          />
        ) : mode === "calendar" || mode === "meetings" ? (
          // Meetings was merged into Calendar — Calendar is the single, dominant
          // surface (month grid + upcoming-meetings sidebar with join/RSVP). Any
          // lingering route to "meetings" lands here so nothing breaks.
          <CalendarView
            externalSearch={gxScope === "calendar" ? gxQuery : ""}
            meetings={meetings}
            people={sortByFreq(users)}
            meId={me && me.id}
            onCreate={onCreateMeeting}
            onJoin={onJoinMeeting}
            onUpdate={onUpdateMeeting}
            onPreviewOccurrences={onPreviewOccurrences}
            onCheckAvailability={onCheckAvailability}
            onMeetingPreview={onMeetingPreview}
            onInvite={onInviteMeeting}
            onDelete={onDeleteMeeting}
            onLeave={onLeaveMeeting}
            onComplete={onCompleteMeeting}
            onToast={showToast}
            defaultTitle={meetingTitle}
            defaultAttendees={meetingAttendees}
            onClearDefaults={() => {
              setMeetingTitle(null);
              setMeetingAttendees([]);
            }}
            openMeetingId={focusMeetingId}
            onOpenedMeeting={() => setFocusMeetingId(null)}
            publicLink={publicLinkFor(tokenRef)}
          />
        ) : mode === "activity" ? (
          <ActivityView
            externalSearch={gxScope === "activity" ? gxQuery : ""}
            conversations={conversations}
            calls={calls}
            voicemails={voicemails}
            onOpenCalls={() => onMode("calls")}
            meetings={meetings}
            meId={me && me.id}
            onMarkRead={onMarkActivityRead}
            onSetRead={onSetReadConversation}
            onJoin={onJoinMeeting}
            onToast={showToast}
            onOpenConversation={(id, msgId) => {
              onSelect(id);
              onMode("chats");
              setJumpMsgId(msgId || null);
            }}
            onOpenPerson={(id) => {
              onSelectPerson(id);
              onMode("chats");
              setJumpMsgId(null);
            }}
            onOpenTask={(taskId) => {
              setOpenTaskId(taskId);
              onMode("tasks");
            }}
            onOpenReminder={(reminderId) => {
              setFocusReminderId(reminderId);
              onMode("reminders");
            }}
            onOpenFile={(fileId) => {
              setOpenFileId(fileId);
              onMode("files");
            }}
            invites={invites}
            onAcceptInvite={onAcceptInvite}
            onDeclineInvite={onDeclineInvite}
            notifications={notifications}
            notifUnread={notifUnread}
            // Optimistic: the row updates on the click, the server call follows.
            // Each of these used to await a full API round trip before the UI
            // moved, which read as a laggy Activity view on a far-away backend.
            // A failed call is harmless here — the next notifications refetch
            // (focus / reconnect) restores the server's truth.
            onMarkNotifRead={async (id) => {
              setNotifications((prev) =>
                prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
              );
              setNotifUnread((c) => Math.max(0, c - 1));
              await api
                .markNotificationRead(tokenRef.current, id)
                .catch(() => { });
            }}
            onMarkAllNotifsRead={async () => {
              setNotifications((prev) =>
                prev.map((n) => ({ ...n, isRead: true })),
              );
              setNotifUnread(0);
              await api
                .markAllNotificationsRead(tokenRef.current)
                .catch(() => { });
            }}
            onDeleteNotif={async (id) => {
              setNotifications((prev) => {
                const gone = prev.find((n) => n.id === id);
                if (gone && !gone.isRead) setNotifUnread((c) => Math.max(0, c - 1));
                return prev.filter((n) => n.id !== id);
              });
              await api
                .deleteNotification(tokenRef.current, id)
                .catch(() => { });
            }}
          />
        ) : mode === "dashboard" ? (
          <DashboardView
            meId={me && me.id}
            token={tokenRef.current}
            onNewCall={(mode) => setModal({ type: "newCall", mode })}
            onNewMessage={() => setModal({ type: "newMessage" })}
            // Files is a hidden module, so "Share file" can't route there: pick a
            // file, then pick the chat(s) to send it to.
            onShareFile={(file: File) => setModal({ type: "shareFile", payload: { file } })}
            conversations={conversations}
            meetings={meetings}
            calls={calls}
            users={users}
            frequentUsers={frequentUsers}
            pendingRequests={
              (invites || []).filter(
                (i) => i.direction === "incoming" && i.status === "pending",
              ).length
            }
            callsSeenAt={callsSeenAt}
            notifCount={Number(notifUnread) || 0}
            tasks={tasks}
            onMode={onMode}
            onScheduleMeeting={() => {
              setMeetingTitle("");
              onMode("calendar");
            }}
            onOpenSearch={(q) => {
              setSearchSeed(q || "");
              onMode("search");
            }}
            onOpenConversation={(id) => {
              onSelect(id);
              onMode("chats");
            }}
            // Figma dashboard: "Join Meeting" on the next-call card goes through
            // the same pre-join flow as the calendar's Join.
            onJoinMeeting={onJoinMeeting}
            // Figma dashboard: a VIP quick-reply chip DRAFTS the text into that
            // conversation's composer (localStorage clb_draft_<id> is what the
            // composer restores on open) and lands on it — it never sends.
            onQuickReply={(id, text) => {
              try {
                window.localStorage.setItem("clb_draft_" + id, text);
              } catch (_) { }
              if (onDraftChange) onDraftChange(id, text);
              onSelect(id);
              onMode("chats");
            }}
            onOpenUnread={() => {
              // Land on Messages filtered to Unread — which now groups by sender
              // org-role tier (see ConversationSidebar roleTiers). Do NOT auto-open
              // a thread: clear the active pane so the main window shows the
              // "Select a conversation" placeholder (ChatView's <Welcome/>), and
              // the user picks an unread conversation from the list to open it.
              setActiveId(null);
              activeIdRef.current = null;
              setFilter("unread");
              onMode("chats");
            }}
            onOpenMissedCalls={() => {
              // Land on Calls scoped to missed-only, grouped by caller role tier.
              setCallsScope("missed");
              onMode("calls");
            }}
            onSelectPerson={(userId) => {
              onSelectPerson(userId);
              onMode("chats");
            }}
          />
        ) : mode === "tasks" ? (
          <TasksView
            externalSearch={gxScope === "tasks" ? gxQuery : ""}
            meId={me && me.id}
            tasks={tasks}
            users={sortByFreq(users)}
            token={tokenRef.current}
            onCreate={onCreateTask}
            onMove={onMoveTask}
            onUpdate={onUpdateTask}
            onDelete={onDeleteTask}
            onBulk={onBulkTasks}
            onSetAssignees={onSetAssignees}
            onWatch={onWatchTask}
            tick={taskTick}
            openTaskId={openTaskId}
            onOpenedTask={() => setOpenTaskId(null)}
            totalCount={taskCount}
            hasMore={taskHasMore}
            loadingMore={taskLoadingMore}
            onLoadMore={loadMoreTasks}
            conflict={taskConflict}
            onClearConflict={() => setTaskConflict(null)}
            onToast={showToast}
            projects={taskProjects}
            views={taskViews}
            projectFilter={taskProjectFilter}
            onProjectFilter={onProjectFilter}
            onCreateProject={onCreateProject}
            onUpdateProject={onUpdateProject}
            onDeleteProject={onDeleteProject}
            onSaveView={onSaveView}
            onUpdateView={onUpdateView}
            onDeleteView={onDeleteView}
          />
        ) : mode === "reminders" ? (
          <RemindersView
            externalSearch={gxScope === "reminders" ? gxQuery : ""}
            reminders={reminders}
            folders={folders}
            counts={reminderCounts}
            totalCount={reminderCount}
            hasMore={reminderHasMore}
            loadingMore={reminderLoadingMore}
            onLoadMore={loadMoreReminders}
            onAdd={onAddReminder}
            onQuickAdd={onQuickAddReminder}
            onToggle={onToggleReminder}
            onDelete={onDeleteReminder}
            onPatch={onPatchReminder}
            onSetStatus={onSetReminderStatus}
            onSnooze={onSnoozeReminder}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onBulk={onBulkReminders}
            focusReminderId={focusReminderId}
            onFocusedReminder={() => setFocusReminderId(null)}
          />
        ) : mode === "contacts" ? (
          <ContactsView
            externalSearch={gxScope === "contacts" ? gxQuery : ""}
            users={sortByFreq(users)}
            // Server-side pagination + search so the Contacts list scales to large
            // directories (the `users` prop above stays the fallback + instant
            // first paint). Returns { users, hasMore }.
            onLoadPage={({ offset, limit, q }) =>
              api.getUsersPage(tokenRef.current, { offset, limit, q })
            }
            meId={me && me.id}
            conversations={conversations}
            onMessage={(id) => {
              // Opening a DM from Contacts lands on the All tab, so the thread
              // is never hidden by a leftover Unread/Groups/Archived filter.
              setFilter("all");
              onMode("chats");
              onSelectPerson(id);
            }}
            onStartChat={onSelectPerson}
            invites={invites}
            onConnect={onSendInvite}
            onAccept={onAcceptInvite}
            onDecline={onDeclineInvite}
            onCancelInvite={onCancelInvite}
            onStartCall={(id, video = false) => {
              const peer = users.find((u) => u.id === id);
              if (peer) onStartCall(peer, video);
            }}
            onAddToGroup={(id) =>
              setModal({ type: "addToGroup", userId: id })
            }
          />
        ) : (
          <CallsView
            externalSearch={gxScope === "calls" ? gxQuery : ""}
            token={tokenRef.current}
            onLoadOlder={onLoadOlderCalls}
            meId={me && me.id}
            onNewCall={(mode) => setModal({ type: "newCall", mode })}
            calls={calls}
            users={users}
            onStartCall={onStartCall}
            showToast={showToast}
            meetings={meetings}
            onJoinMeeting={onJoinMeeting}
            onMode={onMode}
            // Same as the dashboard's "New meeting": a non-null prefill title makes
            // the calendar open its scheduler on arrival.
            onSchedule={() => {
              setMeetingTitle("");
              onMode("calendar");
            }}
            scope={callsScope}
            onScope={setCallsScope}
          />
        )}
        {/* In-content dock: the meeting/call lives INSIDE the module area (rail +
            sidebar stay visible). Navigating to another module minimizes it to a
            floating PiP; "Enlarge" restores it. The component stays MOUNTED
            across dock↔PiP so the call never drops.
            Presentation Mode (P0-11): an INCOMING ring never pops its overlay
            over a live presentation — the call state stays (so if presenting
            ends mid-ring the prompt appears), else it resolves as missed. */}
        {activeCall &&
          !(
            activeCall.status === "ringing" &&
            activeCall.dir === "in" &&
            presentingNow &&
            (settings ? (settings as any).presentationDnd !== false : true)
          ) ? (
          <div
            className={
              "call-dock" +
              (callPip && activeCall.status === "connected" ? " pip" : "")
            }
            onClick={
              callPip && activeCall.status === "connected"
                ? () => setCallPip(false)
                : undefined
            }
          >
            {callPip && activeCall.status === "connected" ? (
              <div
                className="call-pip-bar"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="call-pip-title">
                  {activeCall.peer ? activeCall.peer.name : "Call"}
                </span>
                <button
                  className="call-pip-enlarge"
                  onClick={() => setCallPip(false)}
                  title="Enlarge"
                  aria-label="Enlarge call"
                >
                  <IconMaximize size={14} />
                </button>
              </div>
            ) : null}
            <CallModal
              call={activeCall}
              chatConversationId={
                activeCall.conversationId ||
                (activeCall.peer &&
                  activeCall.peer.id &&
                  (conversations.find(
                    (c: any) =>
                      c &&
                      c.kind === "dm" &&
                      (c.members || []).includes(activeCall.peer.id),
                  ) || {}).id) ||
                null
              }
              huddles={huddles}
              meId={me ? me.id : null}
              onTempGroupCreated={onTempGroupCreated}
              onMoveDevice={openMoveDevice}
              onOpenComms={openComms}
              commsUnread={commsUnread}
              showToast={showToast}
              socket={socketRef.current}
              token={tokenRef.current}
              settings={settings}
              onChangeSetting={changeSetting}
              onAccept={onAcceptCall}
              onDecline={onDeclineCall}
              onCancel={onCancelCall}
              onHangup={onHangup}
              onAddPeople={onAddToCall}
              isGroupHost={(() => {
                // Host if I STARTED this call — remembered across rejoin /
                // reload / 1:1-to-group promotion, where `dir` alone would have
                // demoted me. Group calls key on the conversation; a promoted
                // 1:1 still keys on the peer I originally dialled.
                if (
                  iStartedCall(activeCall.conversationId) ||
                  iStartedCall(activeCall.peer && activeCall.peer.id)
                )
                  return true;
                if (!activeCall.conversationId) return false;
                const c = conversations.find(
                  (x: any) => x.id === activeCall.conversationId,
                );
                const myId = me && me.id;
                return (
                  !!c &&
                  (c.memberRole === "owner" ||
                    c.memberRole === "admin" ||
                    (c.createdBy && myId && c.createdBy === myId))
                );
              })()}
              addPeople={(users || []).filter(
                (u) =>
                  u.id !== (me && me.id) &&
                  // Only people you're mutually CONNECTED with (a DM exists) can be
                  // added to a group call — you can't pull in a stranger.
                  (conversations || []).some(
                    (c) =>
                      c.kind === "dm" && (c.members || []).includes(u.id),
                  ) &&
                  !(
                    activeCall.conversationId &&
                    huddles[activeCall.conversationId] &&
                    (
                      huddles[activeCall.conversationId].participants || []
                    ).some((p) => p.id === u.id)
                  ),
              )}
              // Directory search for the invite modal: the FULL org (not just DM
              // contacts), excluding yourself and anyone already in the call.
              onSearchPeople={(qq: string) =>
                api.searchUsers(tokenRef.current, qq).then((list: any) =>
                  (list || []).filter(
                    (u: any) =>
                      u.id !== (me && me.id) &&
                      !(
                        activeCall.conversationId &&
                        huddles[activeCall.conversationId] &&
                        (
                          huddles[activeCall.conversationId].participants || []
                        ).some((p: any) => p.id === u.id)
                      ),
                  ),
                )
              }
              onMinimize={() => setCallPip(true)}
              pip={callPip}
              // B3 — resolve the conversationId + members the call's media-key
              // distribution should target. Group/channel calls: the conversation
              // itself + its members. 1:1 calls: the DM between me and the peer
              // (looked up in the local cache) + [me, peer]. Returns nulls if no
              // matching conversation exists — media falls back to non-E2EE.
              resolveCallMediaCtx={() => {
                if (activeCall.conversationId) {
                  const cv = conversations.find((c: any) => c && c.id === activeCall.conversationId);
                  return {
                    conversationId: activeCall.conversationId,
                    members: (cv && cv.members) || [],
                  };
                }
                const peerId = activeCall.peer && activeCall.peer.id;
                const myId = me && me.id;
                if (!peerId || !myId) return { conversationId: null, members: [] };
                const dm = conversations.find((c: any) =>
                  c && (c.kind === "dm" || c.kind === "self") &&
                  Array.isArray(c.members) &&
                  c.members.includes(peerId) &&
                  c.members.includes(myId),
                );
                return {
                  conversationId: dm ? dm.id : null,
                  members: [myId, peerId],
                };
              }}
            />
          </div>
        ) : null}
        {roomState ? (
          <div
            className={"call-dock" + (callPip ? " pip" : "")}
            onClick={callPip ? () => setCallPip(false) : undefined}
          >
            {callPip ? (
              <div
                className="call-pip-bar"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="call-pip-title">
                  {(roomState.meeting && roomState.meeting.title) || "Meeting"}
                </span>
                <button
                  className="call-pip-enlarge"
                  onClick={() => setCallPip(false)}
                  title="Enlarge"
                  aria-label="Enlarge meeting"
                >
                  <IconMaximize size={14} />
                </button>
              </div>
            ) : null}
            <MeetingRoom
              room={roomState}
              me={me}
              onMoveDevice={openMoveDevice}
              onOpenComms={openComms}
              commsUnread={commsUnread}
              token={tokenRef.current}
              socket={socketRef.current}
              offline={offlineDemo}
              onLeave={onLeaveRoom}
              onToast={showToast}
              settings={settings}
              onChangeSetting={changeSetting}
              users={sortByFreq(users)}
              conversations={conversations}
              initialMic={joinPrefsRef.current.mic}
              initialCam={joinPrefsRef.current.cam}
              onMinimize={() => setCallPip(true)}
              pip={callPip}
            />
          </div>
        ) : null}
      </div>

      {/* Collaboration sidebar (P0-5, Teams-style): message ANYONE mid-call.
          The LIST is CommsSidebar; opening a conversation renders the REAL
          ChatView (the exact chat window — rich text, files, reactions, E2EE)
          in the sidebar. The call/meeting stays FULL-SIZE — no PiP, no
          navigation, and the main pane's activeId is never touched. */}
      {commsOpen && commsConvId && commsConv
        ? createPortal(
          <div className="comms-sidebar comms-chat-shell" role="complementary" aria-label="Chat while in the call">
            {commsResizeHandle}
            <div className="comms-chat-back">
              <button onClick={() => setCommsConvId(null)} aria-label="Back to all chats">
                <IconChevronLeft size={16} /> All chats
              </button>
              <button className="comms-close" onClick={() => setCommsOpen(false)} aria-label="Close chat sidebar">
                <IconX size={15} />
              </button>
            </div>
            <div className="comms-chat-body">
              <ChatView
                key={commsConvId}
                conversation={commsConv}
                messages={messagesByConv[commsConvId] || EMPTY_ARR}
                token={tokenRef.current}
                meId={me && me.id}
                freqRank={freqRank}
                endedMeetingIds={endedMeetingIds}
                me={me}
                readReceipts={readState[commsConvId] || EMPTY_OBJ}
                showReceipts={settings.readReceipts !== false}
                showLastSeen={settings.lastSeen !== false}
                grouping={settings.messageGrouping !== false}
                linkPreview={settings.linkPreview !== false}
                timeFormat={settings.timeFormat || "12h"}
                linkConfirm={settings.linkConfirm === true}
                sendTyping={settings.sendTyping !== false}
                enterToSend={settings.enterToSend}
                newestAtTop={settings.newestAtTop === true}
                onReply={onReply}
                onSend={(t: string) => onSend(t, commsConvId)}
                onSendFile={(f: File, p?: string | null, c?: string | null, op?: (n: number) => void, al?: boolean) =>
                  onSendFile(f, p, c, op, al, commsConvId)
                }
                onSendMedia={(m: any) => onSendMedia(m, commsConvId)}
                scheduled={scheduledByConv[commsConvId] || EMPTY_ARR}
                onSchedule={onScheduleMessage}
                onReschedule={onRescheduleMessage}
                onCancelScheduled={onCancelScheduled}
                onBack={() => setCommsConvId(null)}
                onReact={onReact}
                onBookmark={onBookmark}
                onForward={onForwardOpen}
                onEditMessage={onEditMessage}
                onDeleteMessage={onDeleteMessage}
                showToast={showToast}
                onJoinMeeting={onJoinMeeting}
                onRejectMeeting={onRejectMeeting}
                onOpenTask={onOpenTaskFromChat}
                onTaskCreated={refetchTasks}
                onTyping={onTyping}
                onDraftChange={onDraftChange}
                onCancelUpload={onCancelUpload}
                typingUserId={typingBy[commsConvId] || null}
                connected={connected}
                offlineDemo={offlineDemo}
                onRetry={retryMessage}
                unreadCount={commsConv.unread || commsConv.unreadAtOpen || 0}
                people={users}
                onLoadEarlier={loadEarlierMessages}
                jumpToMessageId={commsJumpMsgId}
                onJumped={() => setCommsJumpMsgId(null)}
                embedded
              />
            </div>
          </div>,
          document.body,
        )
        : commsOpen
          ? createPortal(
            // The LIST is the REAL Messages sidebar (ConversationSidebar) in
            // `embedded` mode — the exact same component the main app uses (Chat
            // header, All/Requests/Favourites filters, search, DM/Group/Channel
            // sections), not a bespoke list. Selecting a conversation opens the
            // real ChatView in this same panel (or PiPs + opens the full Chat
            // module when the in-meeting-chat setting is on).
            <div className="comms-sidebar comms-list-shell" role="complementary" aria-label="Chat while in the call">
              {commsResizeHandle}
              <div className="comms-chat-body">
                <ConversationSidebar
                  embedded
                  onClose={onCloseComms}
                  conversations={conversations}
                  drafts={drafts}
                  selfPresence={settings.manualPresence || "auto"}
                  loading={!convLoaded}
                  activeId={commsConvId}
                  onSelect={onCommsSelect}
                  // Its OWN filter state: sharing `filter` with the main sidebar
                  // meant switching to Archived/Unread during a call silently
                  // rewrote the Messages module behind the overlay.
                  filter={commsFilter}
                  onFilter={setCommsFilter}
                  search={search}
                  onSearch={onSearch}
                  searchResults={searchResults}
                  onSelectPerson={onCommsSelectPerson}
                  onSelectMessage={onCommsSelectMessage}
                  onStar={onStar}
                  onMute={onMute}
                  onConvAction={onConvAction}
                  onCreateGroup={onOpenCreateGroup}
                  onCreateChannel={onOpenCreateChannel}
                  onNewDm={onCommsNewDm}
                  workspaceName={config.workspaceName}
                  invites={invites}
                  onAcceptInvite={onAcceptInvite}
                  onDeclineInvite={onDeclineInvite}
                />
              </div>
            </div>,
            document.body,
          )
          : null}

      {/* Device handoff (P0-12): the move-to-device picker (source side) and
          the continue-here offer prompt (target side). */}
      {moveDeviceFor ? (
        <DeviceHandoffPicker
          socket={socketRef.current}
          ctx={moveDeviceFor}
          onClose={() => setMoveDeviceFor(null)}
          showToast={showToast}
        />
      ) : null}
      {handoffOffer ? (
        <HandoffOfferPrompt
          offer={handoffOffer}
          onAccept={acceptHandoff}
          onDecline={declineHandoff}
        />
      ) : null}
      {meetingDup ? (
        <MeetingDuplicatePrompt
          dup={meetingDup}
          onMove={() => {
            // Move here: tell the other device(s) to leave; stay on this one.
            try {
              socketRef.current?.emit(EVENTS.MEETING_TAKEOVER, {
                meetingId: meetingDup.meetingId,
              });
            } catch (_) { }
            dupHandledRef.current.add(meetingDup.meetingId);
            setMeetingDup(null);
            showToast("Moving this meeting to this device…");
          }}
          onCompanion={() => {
            // Join on both — keep this device in the meeting, no signal needed.
            dupHandledRef.current.add(meetingDup.meetingId);
            setMeetingDup(null);
          }}
          onCancel={() => {
            // Don't join here: leave the meeting on THIS device.
            setMeetingDup(null);
            onLeaveRoom();
          }}
        />
      ) : null}

      {/* Post-call / post-meeting feedback (#67): ONE shared dialog for every
          surface (1:1 audio/video, group audio/video, meetings). Shown only when
          maybeShowFeedback's gate passes; the same dialog + submit path serves
          both calls and meetings. */}
      {feedbackMeta ? (
        <CallFeedback
          meta={feedbackMeta}
          // Session Replay Lite: a fresh diagnostics report from the session that
          // just ended (stashed by callDiagnostics.stop()) unlocks the attach
          // checkbox on "Had issues".
          diagnosticsAvailable={!!getLastCallReport()}
          onClose={() => setFeedbackMeta(null)}
          onSubmit={(payload: CallFeedbackPayload) => {
            // Fire-and-forget: never block the UI. A lightweight toast confirms.
            // attachDiagnostics is a UI decision — resolve it to the actual
            // report text here (the dialog never touches diagnostics).
            const { attachDiagnostics, ...rest } = payload;
            const rep = attachDiagnostics ? getLastCallReport() : null;
            const body = rep ? { ...rest, diagnostics: rep.text } : rest;
            if (!offlineDemo && tokenRef.current) {
              api
                .submitCallFeedback(tokenRef.current, body)
                .then(() => showToast("Thanks for your feedback!"))
                .catch(() => {
                  /* best-effort; a failed submit is silent (already left) */
                });
            } else {
              showToast("Thanks for your feedback!");
            }
          }}
          onDontShowAgain={() => {
            // THE one source of truth — same setting the Accessibility toggle
            // controls. Only flip + inform when it actually changes.
            if ((settingsRef.current || {}).callFeedback !== false) {
              changeSettingRef.current("callFeedback", false);
              showToast(
                "You can enable call feedback again anytime from Settings → Accessibility.",
              );
            }
          }}
        />
      ) : null}

      {modal && modal.type === "createGroup" ? (
        <CreateGroupModal
          kind="group"
          people={sortByFreq(users.filter((u) => u.id !== (me && me.id)))}
          onClose={() => setModal(null)}
          onCreate={doCreate}
        />
      ) : null}
      {/* Add-to-group (minor 7): pick an EXISTING group/channel to add the contact to
          — previously this wrongly opened the "New Group" dialog. */}
      {modal && modal.type === "addToGroup" ? (
        <div className="mm-overlay" onClick={() => setModal(null)}>
          <div
            className="mm-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420, width: "92vw" }}
          >
            <div style={{ padding: "18px 20px 4px", fontSize: 15, fontWeight: 700 }}>
              Add to group
            </div>
            <div style={{ padding: "0 20px 10px", fontSize: 12.5, color: "var(--g500)" }}>
              Choose an existing group or channel to add this person to.
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto", padding: "0 12px 8px" }}>
              {conversations.filter(
                (c: any) => c.kind === "group" || c.kind === "channel",
              ).length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: "var(--g500)" }}>
                  {"You're not in any groups or channels yet."}
                </div>
              ) : (
                conversations
                  .filter((c: any) => c.kind === "group" || c.kind === "channel")
                  .map((c: any) => {
                    const already = (c.members || []).includes(modal.userId);
                    return (
                      <button
                        key={c.id}
                        disabled={already}
                        onClick={async () => {
                          try {
                            const res: any = await api.addMembers(tokenRef.current, c.id, [modal.userId]);
                            await refetchConversations();
                            const label = c.name || "the group";
                            const noneAdded =
                              res && typeof res.added === "number" && res.added === 0;
                            showToast(noneAdded ? "Already a member of " + label : "Added to " + label);
                          } catch (e: any) {
                            showToast(e?.message || "Couldn't add to the group.");
                          }
                          setModal(null);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          width: "100%",
                          padding: "9px 10px",
                          border: "none",
                          borderRadius: 10,
                          background: "transparent",
                          cursor: already ? "default" : "pointer",
                          textAlign: "left",
                          opacity: already ? 0.5 : 1,
                        }}
                      >
                        <span
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 8,
                            background: "var(--g100)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 15,
                            flex: "0 0 auto",
                          }}
                        >
                          {c.icon || (c.kind === "channel" ? "#" : <IconMessageCircle size={15} />)}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: "var(--g900)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {c.name || (c.kind === "channel" ? "Channel" : "Group")}
                        </span>
                        {already ? (
                          <span style={{ fontSize: 11.5, color: "var(--g500)" }}>
                            Already a member
                          </span>
                        ) : null}
                      </button>
                    );
                  })
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 16px 16px" }}>
              <button className="btn-c" onClick={() => setModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {modal && modal.type === "createChannel" ? (
        <CreateGroupModal
          kind="channel"
          people={sortByFreq(users.filter((u) => u.id !== (me && me.id)))}
          onClose={() => setModal(null)}
          onCreate={doCreate}
        />
      ) : null}
      {modal && modal.type === "createMeeting" ? (
        <div className="mm-overlay" onClick={() => setModal(null)}>
          <div className="mm-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: 20, fontSize: 15, fontWeight: 700 }}>
              New Meeting {modal.with ? `with ${modal.with.name}` : ""}
            </div>
            <div
              style={{
                padding: "0 20px 20px",
                fontSize: 13,
                color: "var(--g600)",
                lineHeight: 1.6,
              }}
            >
              Schedule a meeting with{" "}
              {modal.with ? modal.with.name : "your team"}.
            </div>
            <div style={{ display: "flex", gap: 8, padding: "0 20px 16px" }}>
              <input
                id="mtg-title"
                defaultValue={`Meeting with ${modal.with ? modal.with.name : "team"}`}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1.5px solid var(--g200)",
                  fontSize: 13,
                }}
                placeholder="Meeting title"
              />
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "0 20px 16px",
                justifyContent: "flex-end",
                borderTop: "1px solid var(--g200)",
              }}
            >
              <button
                className="btn btn-ghost"
                onClick={() => setModal(null)}
                style={{ padding: "7px 16px", borderRadius: 8 }}
              >
                Cancel
              </button>
              <button
                className="btn btn-p"
                onClick={async () => {
                  const title =
                    (document.getElementById("mtg-title") as HTMLInputElement)
                      ?.value || "Meeting";
                  await onCreateMeeting({
                    title,
                    attendeeIds: modal.with ? [modal.with.id] : [],
                  });
                  setModal(null);
                  showToast("Meeting created");
                }}
                style={{ padding: "7px 16px", borderRadius: 8 }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {modal && modal.type === "addParticipants"
        ? (() => {
          // Exclude users already in the active group/channel from the picker.
          const activeConv = (conversations || []).find(
            (c) => c.id === activeId,
          );
          const existingIds = new Set(
            ((activeConv && activeConv.members) || []).map(
              (m: any) => m.id || m,
            ),
          );
          return (
            <AddParticipantsModal
              people={sortByFreq(
                users.filter(
                  (u) => u.id !== (me && me.id) && !existingIds.has(u.id),
                ),
              )}
              onClose={() => setModal(null)}
              onAdd={doAddParticipants}
            />
          );
        })()
        : null}
      {modal && modal.type === "newMessage" ? (
        <NewCallModal
          people={sortByFreq(
            (users || []).filter((u) => u.id !== (me && me.id)),
          )}
          mode="message"
          onClose={() => setModal(null)}
          onPick={(u) => {
            setModal(null);
            const otherId = u.id;
            const existing = (conversations || []).find(
              (c) =>
                c.kind === "dm" &&
                c.members &&
                c.members.length === 2 &&
                c.members.some((m) => m.id === (me && me.id)) &&
                c.members.some((m) => m.id === otherId),
            );
            if (existing) {
              onSelect(existing.id);
            } else {
              onSelectPerson(otherId);
            }
            onMode("chats");
          }}
        />
      ) : null}
      {modal && modal.type === "newCall" ? (
        <NewCallModal
          people={sortByFreq(
            (users || []).filter((u) => u.id !== (me && me.id)),
          )}
          mode={modal.mode}
          onClose={() => setModal(null)}
          onPick={(u, video) => {
            setModal(null);
            onStartCall(u, video);
          }}
        />
      ) : null}
      {modal && modal.type === "forward" ? (
        <ForwardModal
          conversations={conversations}
          preview={modal.payload.preview}
          onClose={() => setModal(null)}
          onForward={doForward}
        />
      ) : null}
      {modal && modal.type === "shareFile" ? (
        <ForwardModal
          title="Share file"
          heading="Sharing"
          actionLabel="Send"
          conversations={conversations}
          preview={modal.payload.file.name}
          onClose={() => setModal(null)}
          onForward={async (ids: string[]) => {
            const file: File = modal.payload.file;
            setModal(null);
            for (const id of ids) await onSendFile(file, null, null, undefined, false, id);
            showToast(ids.length === 1 ? "File sent" : `File sent to ${ids.length} chats`);
            if (ids.length === 1) {
              onSelect(ids[0]);
              onMode("chats");
            }
          }}
        />
      ) : null}
      {modal && modal.type === "bookmarks" ? (
        <BookmarksPanel
          items={modal.payload.items}
          onClose={() => setModal(null)}
        />
      ) : null}
      {logoutOpen ? (
        <Modal
          title="Log out"
          onClose={() => setLogoutOpen(false)}
          footer={
            <>
              <Btn onClick={() => setLogoutOpen(false)}>Cancel</Btn>
              <Btn primary onClick={doLogout}>
                Log out
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: "var(--g600)", lineHeight: 1.6 }}>
            Are you sure you want to log out of Collab?
          </p>
        </Modal>
      ) : null}
      {shortcutsOpen ? (
        <Modal
          title="Keyboard shortcuts"
          onClose={() => setShortcutsOpen(false)}
        >
          <div className="shortcuts-grid">
            {[
              {
                h: "General",
                rows: [
                  ["?", "Open this cheat sheet"],
                  ["Esc", "Close dialog / go back"],
                ],
              },
              {
                h: "Chat",
                rows: [
                  ["Enter", "Send message"],
                  ["Shift + Enter", "New line"],
                  ["Ctrl / ⌘ + B", "Bold"],
                  ["Ctrl / ⌘ + I", "Italic"],
                  ["Double-click", "❤️ React to a message"],
                ],
              },
              {
                h: "Calls",
                rows: [["Space", "Push-to-talk (hold, in a call)"]],
              },
              {
                h: "Navigation",
                rows: [
                  ["Click rail ‹", "Collapse / expand nav"],
                  ["Drag edges", "Resize the panes"],
                ],
              },
            ].map((g) => (
              <div className="shortcuts-group" key={g.h}>
                <h4>{g.h}</h4>
                {g.rows.map(([k, lb]) => (
                  <div className="shortcuts-row" key={lb}>
                    <span>{lb}</span>
                    <kbd>{k}</kbd>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
      {manageConvId
        ? (() => {
          const conv = conversations.find((c: any) => c.id === manageConvId);
          if (!conv) return null;
          const myId = me && me.id;
          // Owner / admin from the freshly-serialized memberRole, with a defensive
          // fallback to created-by. Server still enforces and surfaces 403 via the
          // existing toast in onUpdateConversation.
          const canEdit =
            (conv.kind === "group" || conv.kind === "channel") &&
            (conv.memberRole === "owner" ||
              conv.memberRole === "admin" ||
              (conv.createdBy && myId && conv.createdBy === myId));
          return (
            <ManageGroupModal
              conversation={conv}
              canEdit={canEdit}
              onSave={(patch: any) => onUpdateConversation(conv.id, patch)}
              onAvatar={(file: File) =>
                onUploadConversationAvatar(conv.id, file)
              }
              onClose={() => setManageConvId(null)}
            />
          );
        })()
        : null}
      {/* Device check (green room) before entering — gates every join path. */}
      {preJoin ? (
        <PreJoinMeeting
          title={preJoin.title}
          meName={me && me.name}
          meetingId={preJoin.id}
          token={tokenRef.current}
          onCancel={() => setPreJoin(null)}
          onJoin={(prefs) => {
            const id = preJoin.id;
            setPreJoin(null);
            enterMeetingNow(id, prefs);
          }}
        />
      ) : null}
      {inviteOpen ? (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onInvite={onInviteSubmit}
        />
      ) : null}
      {toast ? (
        // BA/CEO #17: professional bottom-right slide-in toast (Teams/Linear
        // style) — a clean surface card with an icon, not a dead-centre pill.
        // Sits ABOVE every overlay (call/meeting z1000, crop/onboarding/help
        // 4000-4600) so in-call host/device toasts are never hidden.
        <div role="status" className="cv-toast">
          {toast && typeof toast === "object" && toast.icon ? toast.icon : null}
          <span>{toast && typeof toast === "object" ? toast.text : toast}</span>
        </div>
      ) : null}
      <DesktopUpdateBanner />
      {/* Pull a fresh deploy into a long-open web/desktop session on its own —
          banner + a silent refresh when the user returns to an idle, hidden tab
          (never during a call/meeting). */}
      <UpdateWatcher
        busy={!!(activeCall || roomState)}
        notify={settings.notifyUpdates !== false}
      />
      <GlobalTooltip />
      {/* AUDIT #43: single host for app-styled confirm/prompt/alert dialogs. */}
      <DialogHost />
      {/* Sticker/GIF creation studio — one portaled host, above chat + call + gif picker. */}
      <MediaStudioHost getToken={() => tokenRef.current} />
    </div>
  );
}
