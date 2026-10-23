// BA/CEO #22: export a canvas as a real PDF with no third-party dependency.
// PDF natively decodes baseline JPEG via the /DCTDecode filter, so we embed the
// canvas' JPEG bytes directly as an image XObject and hand-assemble a minimal,
// spec-valid single-page PDF.
//
// The page is a standard A4 sheet (orientation chosen from the image's aspect),
// and the board is scaled to FIT the page with a small margin and centred — so
// the export is always ONE clean, normal-sized page. (An earlier version sized
// the page to the canvas' raw DEVICE-pixel dimensions, which on a 2x display
// produced a giant, half-filled sheet.)
const A4_SHORT = 595.28; // points (72dpi)
const A4_LONG = 841.89;
const MARGIN = 24;

export function canvasToPdfBlob(canvas: HTMLCanvasElement): Blob {
  const iw = canvas.width;
  const ih = canvas.height;

  // JPEG (not PNG): PDF can embed JPEG streams verbatim via /DCTDecode. Quality
  // 0.92 keeps ink/edges crisp without bloating the file.
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const jpg = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpg[i] = bin.charCodeAt(i);

  // Landscape page for a wider-than-tall board, portrait otherwise.
  const landscape = iw >= ih;
  const pageW = landscape ? A4_LONG : A4_SHORT;
  const pageH = landscape ? A4_SHORT : A4_LONG;

  // Fit (contain) the image inside the page's printable area, then centre it.
  const availW = pageW - 2 * MARGIN;
  const availH = pageH - 2 * MARGIN;
  const scale = Math.min(availW / iw, availH / ih);
  const drawW = iw * scale;
  const drawH = ih * scale;
  const tx = (pageW - drawW) / 2;
  const ty = (pageH - drawH) / 2; // PDF origin is bottom-left; centring is symmetric

  const fmt = (n: number) => n.toFixed(2);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (u8: Uint8Array) => {
    chunks.push(u8);
    offset += u8.length;
  };
  const pushStr = (s: string) => push(enc.encode(s));
  const startObj = (n: number) => {
    offsets[n] = offset;
  };

  pushStr("%PDF-1.4\n");

  startObj(1);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObj(2);
  pushStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  startObj(3);
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
  );

  // Content stream: scale + translate the unit image into its centred box.
  const content = `q\n${fmt(drawW)} 0 0 ${fmt(drawH)} ${fmt(tx)} ${fmt(ty)} cm\n/Im0 Do\nQ\n`;
  startObj(4);
  pushStr(
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  );

  startObj(5);
  pushStr(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpg.length} >>\nstream\n`,
  );
  push(jpg);
  pushStr("\nendstream\nendobj\n");

  const xrefStart = offset;
  const count = 6; // objects 0..5
  pushStr(`xref\n0 ${count}\n`);
  pushStr("0000000000 65535 f \n");
  for (let i = 1; i < count; i++) {
    pushStr(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  }
  pushStr(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
  );

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}
