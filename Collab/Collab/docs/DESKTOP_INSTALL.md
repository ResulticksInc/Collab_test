# Installing the Collab desktop app (internal)

The Collab desktop app is currently **unsigned** (internal use — no code‑signing
certificate yet). That's safe, but your OS will show a one‑time "unknown
publisher" warning on first launch. Here's how to get past it, per platform.

> You only see these warnings **once per install**. Updates afterward are smooth.

---

## Windows

1. Download `Collab Setup <version>.exe` from the internal share / GitHub Release.
2. Double‑click it. Windows **SmartScreen** may show *"Windows protected your PC."*
3. Click **More info** → **Run anyway**.
4. Install normally. Done.

*(If your org uses SmartScreen for Business / WDAC, IT may need to allow‑list the
app once — share the SHA‑256 checksum below with them.)*

---

## macOS

1. Download `Collab <version>.dmg`, open it, drag **Collab** to Applications.
2. The first time you open it, **Gatekeeper** says it *"cannot be opened because
   the developer cannot be verified."*
3. **Right‑click** (or Control‑click) the Collab app → **Open** → **Open** again.
   - If there's no Open button: **System Settings → Privacy & Security**, scroll
     to the message about Collab, click **Open Anyway**, then reopen.
4. Done — macOS remembers your choice.

---

## Linux

No warning — Linux doesn't gate unsigned apps the same way.

- **AppImage:** `chmod +x Collab-<version>.AppImage` then run it (or double‑click).
- **.deb:** `sudo dpkg -i collab_<version>_amd64.deb` (or open with your software
  installer).

---

## Verify your download (optional but recommended for IT)

Each GitHub Release publishes a `SHA256SUMS.txt`. Verify the installer matches:

- **Windows (PowerShell):** `Get-FileHash .\Collab` *(tab‑complete the filename)* — compare the `SHA256` to the line in `SHA256SUMS.txt`.
- **macOS / Linux:** `shasum -a 256 Collab-<version>.AppImage` — compare to `SHA256SUMS.txt`.

If the hash matches, the file wasn't tampered with in transit.

---

## Updates

The app checks for updates on launch and prompts you when a newer version is
available — just accept and it installs over the top (your data + sign‑in are
preserved). No need to repeat the warning bypass above for updates.

---

## "Why is it unsigned?"

Code‑signing certificates cost money per year and are meant for **public**
distribution (so strangers can trust a download). For an **internal** tool
distributed through our own channels, the one‑time OS warning + the checksum
verification above are proportionate. When Collab ships externally, we'll add a
signing certificate and these warnings disappear — no reinstall needed.
