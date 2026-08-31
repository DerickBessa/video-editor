// ASS (Advanced SubStation Alpha) generation.
//
// ASS is the right format here, not SRT: it carries positioning, outline,
// shadow, per-word colour, scaling and time-based transforms, and this FFmpeg
// build renders it natively through libass. That covers everything phases 1-4
// need from captions without pulling in Remotion.
//
// Two conventions in ASS routinely cause silent breakage, so they are handled
// in one place here:
//
//   Colours are &HAABBGGRR — BGR order, not RGB, and AA is TRANSPARENCY
//   (00 = fully opaque, FF = invisible). Writing an RGB hex straight in gives
//   you the wrong colour with no error.
//
//   PlayResX/PlayResY define the coordinate space that font sizes and margins
//   are interpreted in. If they do not match the video, libass silently scales
//   everything and captions come out the wrong size.

/** "#RRGGBB" (or "#RRGGBBAA") -> "&HAABBGGRR". */
export function assColor(hex, alpha) {
  const s = String(hex).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    throw new Error(`Invalid colour "${hex}", expected #RRGGBB`);
  }
  const r = s.slice(0, 2), g = s.slice(2, 4), b = s.slice(4, 6);
  // Opacity in, transparency out.
  const a = alpha !== undefined
    ? Math.round((1 - clamp01(alpha)) * 255).toString(16).padStart(2, '0')
    : (s.length === 8 ? s.slice(6, 8) : '00');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

const clamp01 = v => Math.min(1, Math.max(0, Number(v)));

/** Seconds -> "H:MM:SS.CC" (ASS uses centiseconds, not milliseconds). */
export function assTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  // Rounding centiseconds can carry into the next second.
  const carry = cs === 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(carry ? s + 1 : s).padStart(2, '0')}.` +
    `${String(carry ? 0 : cs).padStart(2, '0')}`;
}

/** Escape text for a Dialogue line: braces open override blocks, \n is a break. */
export function assEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Numeric alignment for \an and the Style Alignment field (numpad layout):
 *   7 8 9   top
 *   4 5 6   middle
 *   1 2 3   bottom
 */
export const ALIGNMENT = {
  'bottom-left': 1, 'bottom': 2, 'bottom-center': 2, 'center-bottom': 2, 'bottom-right': 3,
  'left': 4, 'center': 5, 'middle': 5, 'right': 6,
  'top-left': 7, 'top': 8, 'top-center': 8, 'center-top': 8, 'top-right': 9,
};

export function alignmentFor(position) {
  const a = ALIGNMENT[String(position).toLowerCase()];
  if (a === undefined) {
    throw new Error(`Unknown caption position "${position}". Use one of: ${Object.keys(ALIGNMENT).join(', ')}`);
  }
  return a;
}

/**
 * @typedef {Object} AssStyle
 * @property {string} name
 * @property {string} font
 * @property {number} fontSize      in PlayRes units
 * @property {string} primaryColor  #RRGGBB - the fill
 * @property {string} secondaryColor  used by \k karaoke as the "not yet sung" fill
 * @property {string} outlineColor
 * @property {string} backColor     shadow colour
 * @property {number} outline       px
 * @property {number} shadow        px
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {number} alignment
 * @property {number} marginL @property {number} marginR @property {number} marginV
 * @property {number} [scaleX] @property {number} [scaleY] @property {number} [spacing]
 */

export function styleLine(s) {
  return [
    'Style: ' + s.name,
    s.font,
    round(s.fontSize),
    assColor(s.primaryColor),
    assColor(s.secondaryColor ?? s.primaryColor),
    assColor(s.outlineColor),
    assColor(s.backColor, s.backOpacity),
    s.bold ? -1 : 0,
    s.italic ? -1 : 0,
    0,                       // Underline
    0,                       // StrikeOut
    round(s.scaleX ?? 100),
    round(s.scaleY ?? 100),
    round(s.spacing ?? 0),
    0,                       // Angle
    s.borderStyle ?? 1,      // 1 = outline+shadow, 3 = opaque box
    round(s.outline),
    round(s.shadow),
    s.alignment,
    round(s.marginL),
    round(s.marginR),
    round(s.marginV),
    1,                       // Encoding
  ].join(',');
}

const round = n => Math.round(Number(n) * 100) / 100;

/**
 * @param {{width:number, height:number, styles:AssStyle[], events:Array}} doc
 * @returns {string} a complete .ass file
 */
export function buildAss({ width, height, styles, events, title = 'video-editor captions' }) {
  const header = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    // Must match the video, or libass silently rescales every size and margin.
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, ' +
      'Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles.map(styleLine),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const lines = events.map(e =>
    `Dialogue: ${e.layer ?? 0},${assTime(e.start)},${assTime(e.end)},${e.style},,` +
    `${e.marginL ?? 0},${e.marginR ?? 0},${e.marginV ?? 0},${e.effect ?? ''},${e.text}`
  );

  return [...header, ...lines, ''].join('\n');
}

/* ------------------------------------------------------- override helpers */

/** A time-based transform: \t(t1,t2,tags) — the basis of every caption animation. */
export const t = (from, to, tags) => `\\t(${Math.round(from)},${Math.round(to)},${tags})`;

/** Fade in/out, in milliseconds. */
export const fad = (inMs, outMs) => `\\fad(${Math.round(inMs)},${Math.round(outMs)})`;

/** Uniform scale, as a percentage. */
export const scale = pct => `\\fscx${round(pct)}\\fscy${round(pct)}`;

/** Wrap override tags in a block. */
export const tags = (...parts) => `{${parts.filter(Boolean).join('')}}`;
