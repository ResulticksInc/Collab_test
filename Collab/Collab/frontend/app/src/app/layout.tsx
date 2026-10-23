import "../styles/v1.css";
import "../styles/tokens.css";
import "../styles/ui.css";
import "../styles/rail.css";
import "../styles/dashboard.css";
import "../styles/search.css";
import "../styles/contacts.css";
import "../styles/chats.css";
import "../styles/calendar.css";
import "../styles/call.css";
import "../styles/guest-join.css";
import "../styles/ui-refresh.css";
import "../styles/dashboard-refresh.css";
import "../styles/calendar-refresh.css";
import "../styles/calls-refresh.css";
import "../styles/activity-refresh.css";
import "../styles/contacts-refresh.css";
import "../styles/accent-theme.css";
import "../styles/settings-refresh.css";
import DesktopChrome from "../components/DesktopChrome";
// Brand name is build-time (NEXT_PUBLIC_APP_NAME) so the tab title matches the
// in-app brand ("Collab"). The favicon is the app-router icon.svg in this dir,
// which Next auto-injects — replacing the browser's default globe.
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Collab";
export const metadata = {
  title: APP_NAME,
  description: "Enterprise collaboration platform",
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Boot background: the product gradient instead of a white flash. Defined
            here (inline, first in <head>) so it exists before any bundle loads and
            is reused by the loading placeholder, loading.tsx and AppSplash. Light =
            soft brand lavender, dark/oled (body.dark, set by the pre-paint script
            below) = deep brand purple. */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              ":root{--boot-bg:linear-gradient(135deg,#f6f1ff 0%,#e8ddff 50%,#d8c6f6 100%)}" +
              "body.dark{--boot-bg:linear-gradient(135deg,#120a22 0%,#2a0f45 55%,#381354 100%)}" +
              "html,body{min-height:100%}body{background:var(--boot-bg);background-attachment:fixed;font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;}",
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Non-blocking: a render-blocking Google Fonts stylesheet holds the first
            paint (white screen) until it downloads or times out — e.g. on a slow or
            firewalled network. media="print" lets the page paint immediately; the
            script below flips it to "all" once loaded (font-display:swap applies). */}
        <link
          id="gf-fonts"
          rel="stylesheet"
          media="print"
          suppressHydrationWarning
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap"
        />
      </head>
      <body suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){var l=document.getElementById("gf-fonts");if(!l)return;function on(){l.media="all"}if(l.sheet)on();else l.addEventListener("load",on);})();',
          }}
        />
        <noscript>
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          />
        </noscript>
        {/* Apply the saved theme BEFORE first paint so a hard refresh in dark mode
            never flashes the light splash first. Reads the theme CoLabV1 caches in
            localStorage; the classes mirror the in-app theme effect. Fail-silent, and
            a no-op on a fresh browser (defaults to light, as before). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              // Collab is always light: drop any cached dark/oled theme so the
              // pre-paint pass never paints a dark flash before settings load.
              '(function(){try{localStorage.setItem("clb_theme","light");}catch(e){}})();',
          }}
        />
        <DesktopChrome />
        {children}
      </body>
    </html>
  );
}
