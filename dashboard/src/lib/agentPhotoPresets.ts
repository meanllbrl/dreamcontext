/**
 * The six generated preset photos the New agent dialog offers.
 *
 * WHY THESE ARE PNGs AND NOT SVG DATA URIs. The prototype drew them as inline
 * SVG, which is fine in a prototype and wrong here: an SVG can carry
 * `<script>`, so the photo route deliberately has no SVG branch (the same rule
 * `agent-chat.ts` states for `?raw=1`). Rendering to a canvas and uploading
 * PNG bytes means a preset travels the IDENTICAL path as a file the owner
 * picked — one upload route, one magic-byte check, one stored file per agent —
 * rather than a second, privileged "trust this one" channel.
 *
 * Palettes are muted on purpose (K8, the accent budget): six saturated
 * squares in a row would out-shout the dialog's one primary button.
 */

export interface PhotoPreset {
  id: number;
  /** Background, then the figure. Both fixed hex, NOT theme tokens: these
   *  become a PNG on disk that outlives the theme it was created under, so
   *  reading a token here would bake whatever mode the owner happened to be in
   *  into a permanent file. */
  bg: string;
  fg: string;
}

export const PHOTO_PRESETS: PhotoPreset[] = [
  { id: 0, bg: '#dfe3f3', fg: '#5b6270' },
  { id: 1, bg: '#e8e2d6', fg: '#5f5343' },
  { id: 2, bg: '#d9ebe3', fg: '#2f5f4a' },
  { id: 3, bg: '#eadff0', fg: '#5a3f6b' },
  { id: 4, bg: '#f3e3dc', fg: '#6b4a3d' },
  { id: 5, bg: '#e0e9ef', fg: '#3d5566' },
];

/** Edge length of a generated preset, in px. 256 is comfortably above the
 *  56px the dialog previews at on a 2x display, and still a few KB. */
const PRESET_SIZE = 256;

/**
 * Draw one preset — a soft shoulders-and-head silhouette with the agent's
 * initials over it — and hand back PNG bytes ready to upload.
 *
 * Rejects rather than resolving null on a missing 2D context: the caller
 * treats a failed preset as "no photo was set", and swallowing the reason
 * would leave the owner clicking a preset that silently does nothing.
 */
export function renderPreset(preset: PhotoPreset, initials: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = PRESET_SIZE;
    canvas.height = PRESET_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('This browser could not draw the preset photo.'));
      return;
    }
    const s = PRESET_SIZE;

    ctx.fillStyle = preset.bg;
    ctx.fillRect(0, 0, s, s);

    ctx.fillStyle = preset.fg;
    ctx.globalAlpha = 0.9;
    // Head.
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.41, s * 0.172, 0, Math.PI * 2);
    ctx.fill();
    // Shoulders — an arc rather than a rectangle so it reads as a person at
    // 32px, which is the size the preset row itself renders at.
    ctx.beginPath();
    ctx.moveTo(s * 0.19, s * 0.95);
    ctx.quadraticCurveTo(s * 0.5, s * 0.56, s * 0.81, s * 0.95);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = preset.bg;
    ctx.font = `700 ${Math.round(s * 0.17)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, s * 0.5, s * 0.42);

    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('This browser could not encode the preset photo.'));
    }, 'image/png');
  });
}
