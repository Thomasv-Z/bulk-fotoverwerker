import { parentPort, workerData } from 'worker_threads';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

(async () => {
  try {
    const {
      inputPath,
      outputPath,
      mode,
      dateText,
      eventText,
      logoPath,
      marginEm = 1,          // afstand tot randen in em (1em = fontSize)
      textMaxWidthPct = 0.9, // max horizontale ruimte voor tekst t.o.v. fotobreedte (zonder downscale)
      overlayOpacity = 0.75  // globale transparantie van het volledige watermark
    } = workerData;

    let image = sharp(inputPath, { failOn: 'none' }).toColorspace('srgb');

    const needEdit = (mode === 'edit-watermark' || mode === 'edit-only');
    const needWatermark = (mode === 'edit-watermark' || mode === 'watermark-only');

    if (needEdit) {
      image = await safeColorAdjust(image);
    }

    const meta = await image.metadata();
    const baseWidth = meta.width || 2000;
    const baseHeight = meta.height || 1333;

    if (needWatermark) {
      const overlay = await buildWatermarkOverlay({
        baseWidth,
        baseHeight,
        dateText: dateText || '',
        eventText: eventText || '',
        logoPath,
        marginEm,
        textMaxWidthPct,
        overlayOpacity
      });

      if (overlay) {
        const { buffer: wmBuf, width: wmW, height: wmH, marginPx } = overlay;

        // Rechts-onder met marge in px
        const left = Math.max(0, baseWidth - wmW - marginPx);
        const top  = Math.max(0, baseHeight - wmH - marginPx);

        image = await image.composite([{ input: wmBuf, left, top }]);
      }
    }

    // Output-extensie bepalen
    let outExt = path.extname(outputPath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(outExt)) outExt = '.jpg';
    const outPathFinal = outputPath.replace(/\.[^.]+$/, outExt);

    let pipeline = image;
    if (outExt === '.jpg' || outExt === '.jpeg') pipeline = pipeline.jpeg({ quality: 90, chromaSubsampling: '4:4:4' });
    else if (outExt === '.png') pipeline = pipeline.png({ compressionLevel: 9 });
    else if (outExt === '.webp') pipeline = pipeline.webp({ quality: 90 });

    await fs.mkdir(path.dirname(outPathFinal), { recursive: true });
    await pipeline.toFile(outPathFinal);

    parentPort.postMessage({ type: 'done' });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
})();

// ————— Helpers —————
async function safeColorAdjust(img) {
  try {
    return img
      .linear(1.08)
      .gamma(0.97)
      .modulate({ saturation: 1.10 })
      .normalize();
  } catch (_) {
    return img.modulate({ saturation: 1.06 });
  }
}

/**
 * Een enkele regel tekst als links-uitgelijnde SVG (we meten/trimmen per regel, uitlijnen doen we bij compositing).
 * Opacity hier op 1; totale transparantie komt van overlayOpacity.
 */
function makeTextLineSVG({ text, font }) {
  const padding = Math.round(font * 0.3);
  const fg = '#ffffff';
  const escaped = escapeXml(text);
  const height = padding + font + padding;
  const BIG_CANVAS = 8192; // ruim canvas; we trimmen naderhand

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${BIG_CANVAS}" height="${height}">
  <style>
    .wm-text {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Noto Sans', 'Liberation Sans', sans-serif;
      font-weight: 700;
      font-size: ${font}px;
      fill: ${fg};
      opacity: 1;
    }
  </style>
  <text x="${padding}" y="50%" dominant-baseline="middle" text-anchor="start" class="wm-text">${escaped}</text>
</svg>`;
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&apos;');
}

/**
 * Render en trim één regel tekst → buffer + gemeten breedte/hoogte.
 */
async function renderTrimmedLine({ text, fontSize }) {
  const svg = makeTextLineSVG({ text, font: fontSize });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const trimmed = await sharp(png).trim().png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  return { buffer: trimmed, width: meta.width || 1, height: meta.height || Math.round(fontSize * 1.6) };
}

/**
 * Breek tekst in meerdere regels zodat elke regel ≤ maxLineWidth blijft, ZONDER het font te verkleinen.
 * Greedy op woordniveau.
 */
async function wrapTextToWidth({ fullText, fontSize, maxLineWidth }) {
  const words = fullText.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const empty = await renderTrimmedLine({ text: ' ', fontSize });
    return { lines: [empty], totalWidth: empty.width, totalHeight: empty.height };
  }

  const lines = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const tryLine = current ? `${current} ${words[i]}` : words[i];
    const measured = await renderTrimmedLine({ text: tryLine, fontSize });
    if (measured.width <= maxLineWidth) {
      current = tryLine;
    } else {
      // push de vorige lijn (als die bestaat), en start met huidig woord
      if (current) {
        const prev = await renderTrimmedLine({ text: current, fontSize });
        lines.push(prev);
        current = words[i];
      } else {
        // Enkel woord is al breder dan maxLineWidth: forceer harde break (we laten het toe als één te brede lijn)
        lines.push(measured);
        current = '';
      }
    }
  }
  if (current) {
    const last = await renderTrimmedLine({ text: current, fontSize });
    lines.push(last);
  }

  const totalWidth = Math.max(...lines.map(l => l.width));
  const totalHeight = lines.reduce((sum, l) => sum + l.height, 0);
  return { lines, totalWidth, totalHeight };
}

/**
 * Bouwt de watermark-overlay (logo boven, tekst eronder), rechts uitgelijnd.
 * Tekst wordt NIET verkleind; als 'ie te lang is voor de beschikbare breedte, wrappen we over meerdere regels.
 */
async function buildWatermarkOverlay({ baseWidth, baseHeight, dateText, eventText, logoPath, marginEm, textMaxWidthPct, overlayOpacity }) {
  const shortestSide = Math.min(baseWidth, baseHeight);

  // Kies een royale fontgrootte, onafhankelijk van 1/5-regel
  const eventFont = clamp(Math.round(shortestSide * 0.028), 18, 96); // ±2.8% van kortste zijde
  const padding = Math.max(2, Math.round(eventFont * 0.35));
  const lineGap = Math.max(2, Math.round(eventFont * 0.30));

  // Marge in px (1em = font)
  const marginPx = Math.max(0, Math.round((marginEm || 0) * eventFont));

  // Beschikbare breedte voor tekstblokken (we willen in z'n geheel binnen beeld blijven)
  const maxTextBlockWidth = Math.max(120, Math.round(baseWidth * clamp(textMaxWidthPct || 0.9, 0.2, 0.98)) - marginPx);

  const combinedText = `${(eventText || '').trim()} ${(dateText || '').trim()}`.trim();

  // — Logo renderen (hoogte in em)
  let logoWidth = 0, logoHeight = 0, logoBuffer = null;
  if (logoPath && existsSync(logoPath)) {
    const desiredHeight = Math.round(eventFont * 2.2); // 2.2em voelt gebalanceerd
    const logoSharp = sharp(logoPath).png();
    try {
      const logoMetadata = await logoSharp.metadata();
      if (logoMetadata && (logoMetadata.width || logoMetadata.height)) {
        const resized = await logoSharp.resize({ height: desiredHeight, fit: 'inside' }).toBuffer();
        const resizedMetadata = await sharp(resized).metadata();
        logoBuffer = resized;
        logoWidth = resizedMetadata.width || 0;
        logoHeight = resizedMetadata.height || 0;
      }
    } catch (error) {
      console.error(`Error processing logo image: ${error.message}`);
      logoBuffer = null;
    }
  }

  // — Tekst wrappen tot maxTextBlockWidth (zonder font te verkleinen)
  const wrapped = await wrapTextToWidth({
    fullText: combinedText.length ? combinedText : ' ',
    fontSize: eventFont,
    maxLineWidth: maxTextBlockWidth - 2 * padding
  });

  const textLines = wrapped.lines; // [{buffer,width,height}, ...]
  const textBlockWidth = Math.max(...textLines.map(l => l.width), 1);
  const textBlockHeight = textLines.reduce((sum, l) => sum + l.height, 0) + (textLines.length > 1 ? (textLines.length - 1) * lineGap : 0);

  // Overlay-breedte = max(logo, tekst) + 2*padding
  const contentWidth = Math.max(logoWidth, textBlockWidth);
  const overlayWidth = Math.round(contentWidth + 2 * padding);
  const overlayHeight = Math.round(
    padding + (logoBuffer ? logoHeight + lineGap : 0) + textBlockHeight + padding
  );

  // Transparante canvas
  const canvas = sharp({
    create: { width: overlayWidth, height: overlayHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  });

  const composites = [];

  // Logo rechtsboven in overlay
  if (logoBuffer) {
    const logoLeft = Math.max(0, overlayWidth - padding - logoWidth);
    const logoTop = padding;
    composites.push({ input: logoBuffer, left: logoLeft, top: logoTop });
  }

  // Tekstregels rechts uitlijnen, onder logo
  let cursorY = Math.round(padding + (logoBuffer ? logoHeight + lineGap : 0));
  for (const line of textLines) {
    const lineLeft = Math.max(0, overlayWidth - padding - line.width);
    composites.push({ input: line.buffer, left: lineLeft, top: cursorY });
    cursorY += line.height + lineGap;
  }

  // Buffer + globale opacity toepassen (alpha-kanaal schalen)
  const watermarkBuffer = await canvas.composite(composites).png().toBuffer();
  const alpha = Math.max(0, Math.min(1, overlayOpacity));
  const fadedBuffer = await sharp(watermarkBuffer)
    .ensureAlpha()                                // zorg dat er een alpha-kanaal is
    .linear([1, 1, 1, alpha], [0, 0, 0, 0])       // schaal alleen het alpha-kanaal
    .png()
    .toBuffer();

  return {
    buffer: fadedBuffer,
    width: overlayWidth,
    height: overlayHeight,
    fontSize: eventFont,
    marginPx
  };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
