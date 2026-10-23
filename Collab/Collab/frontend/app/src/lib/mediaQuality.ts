// Shared audio/video quality policy for meetings (MeetingStage) and calls
// (useCallSessionMedia), so the two paths can't drift apart.
//
// CAMERA: capture 720p30 and publish a 180p / 360p / 720p simulcast ladder.
// The previous 1080p top layer looked good on paper but hurt in practice:
//   • the ladder jumped from 360p straight to 1080p, so any viewer (or sender)
//     who couldn't sustain ~3.5 Mbps fell all the way back to 360p — a blurry
//     full-screen picture on exactly the ordinary links most people have;
//   • in meetings the 1080p layer was capped at 1.7 Mbps, which starves 1080p
//     (blocky) while being plenty for a crisp 720p;
//   • encoding 1080p + two more layers costs laptop CPU, and dropped frames are
//     what people actually perceive as "bad video".
// 720p is also the native resolution of most webcams. Each rung is now a
// reachable step, so quality degrades and recovers gradually with bandwidth.
export const CAMERA_CAPTURE = { width: 1280, height: 720, frameRate: 30 } as const;
export const MEETING_VIDEO_MAX_BITRATE = 1_700_000; // many publishers per room
export const CALL_VIDEO_MAX_BITRATE = 2_000_000; // 1:1 / small group

// AUDIO FIRST. When the link is thin the browser has to choose what to send;
// mark the microphone's RTP stream high priority so congestion control sheds
// VIDEO bits before it touches the voice. (Opus RED + DTX are already on via
// livekit-client's publish defaults: RED repairs isolated packet loss, DTX stops
// sending during silence.) Best-effort — unsupported browsers just ignore it.
export function prioritizeAudioSender(publication: any): void {
  try {
    const track = publication && publication.track;
    if (!track || track.kind !== "audio") return;
    const sender: RTCRtpSender | undefined = track.sender;
    if (!sender || typeof sender.getParameters !== "function") return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    for (const enc of params.encodings as any[]) {
      enc.priority = "high";
      enc.networkPriority = "high";
    }
    void sender.setParameters(params).catch(() => {});
  } catch (_) {
    /* best-effort */
  }
}
