// Cross-browser fullscreen helpers (Chrome, Firefox, Safari vendor prefixes).
//
// Extracted from MeetingStage as part of decomposing that component. Pure DOM,
// no React and no meeting state, so it is safe to share with the call dock and
// anything else that needs a fullscreen toggle.

export function fsRequest(el: HTMLElement) {
  if (el.requestFullscreen) return el.requestFullscreen().catch(() => {});
  if ((el as any).webkitRequestFullscreen)
    return Promise.resolve((el as any).webkitRequestFullscreen());
  if ((el as any).mozRequestFullScreen)
    return Promise.resolve((el as any).mozRequestFullScreen());
  return Promise.resolve();
}

export function fsExit() {
  if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
  if ((document as any).webkitExitFullscreen)
    return Promise.resolve((document as any).webkitExitFullscreen());
  if ((document as any).mozCancelFullScreen)
    return Promise.resolve((document as any).mozCancelFullScreen());
  return Promise.resolve();
}

export function fsElement(): Element | null {
  return (
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    null
  );
}
