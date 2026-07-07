/* Unified dreamcontext desktop app — wireframe map (v3, combined IA).
 * Edit this, then: node boards/_spec/unified-dashboard-wireframes.gen.cjs
 * Generates ../../_dream_context/inbox/unified-dashboard-wireframes.excalidraw.md
 *
 * Combined information architecture:
 *   App level (shell home, above any vault): Launcher · Open Project · Second-brain picker
 *   Vault level sidebar:
 *     WORKSPACE  : Overview · Brain · Tasks · Knowledge · Features · Core · Council · Taxonomy · Sleep
 *     FEDERATION : Connections · Inbox            (promoted out of Settings)
 *     CONTROL    : Packs · Settings
 *     Footer     : Accessibility · About          (app-wide)
 * Theme: ClickUp "Vibrant Productivity Hub" — violet #7b68ee · ink #292d34 · Plus Jakarta + Inter.
 */
const path = require('path');
const { buildExcalidraw } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/build_excalidraw.js'));

// ---- palette ---------------------------------------------------------------
const INK = '#292d34', MUTED = '#646464', FAINT = '#9aa0b3', LINE = '#e1e3ea';
const WHITE = '#ffffff', SIDE = '#f7f7fb', FOG = '#e9ebf0';
const VIO = '#7b68ee', VIOBG = '#ede9fe';   // accent / in-progress
const REV = '#6647f0', REVBG = '#ece9fd';   // in-review
const TODO = '#ff7a00', TODOBG = '#fff0e0'; // todo / warning
const DONE = '#16a34a', DONEBG = '#dcfce7'; // completed / success / a11y
const ERR = '#e11d48', ERRBG = '#ffe4e6';
const MAG = '#c026d3', MAGBG = '#fae8ff';   // SECOND BRAIN + federation identity

const E = [];
const rect = (x, y, w, h, o = {}) => E.push({ type: 'rectangle', x, y, width: w, height: h, roundness: o.round === undefined ? true : o.round, backgroundColor: o.bg || 'transparent', fillStyle: 'solid', strokeColor: o.stroke || INK, strokeWidth: o.sw || 1 });
const ell = (x, y, w, h, o = {}) => E.push({ type: 'ellipse', x, y, width: w, height: h, backgroundColor: o.bg || 'transparent', fillStyle: 'solid', strokeColor: o.stroke || INK, strokeWidth: o.sw || 1 });
const dia = (x, y, w, h, o = {}) => E.push({ type: 'diamond', x, y, width: w, height: h, backgroundColor: o.bg || 'transparent', fillStyle: 'solid', strokeColor: o.stroke || INK, strokeWidth: o.sw || 1 });
const txt = (x, y, text, o = {}) => E.push({ type: 'text', x, y, text, fontSize: o.size || 11, color: o.color || INK, ...(o.width ? { width: o.width } : {}), ...(o.align ? { align: o.align } : {}) });
const arrow = (pts, o = {}) => E.push({ type: 'arrow', points: pts, strokeColor: o.color || FAINT, strokeWidth: o.sw || 2, endArrow: true });
const chip = (x, y, t, o = {}) => { const w = o.w || (t.length * 4.6 + 12); rect(x, y, w, 14, { bg: o.bg || FOG, stroke: o.stroke || LINE, sw: 1 }); txt(x + 5, y + 3, t, { size: 7.5, color: o.color || MUTED }); return w; };

// ---- geometry --------------------------------------------------------------
const W = 410, H = 320, SB = 104, HB = 26;
const COLX = [60, 600, 1140, 1680];
const B = {};

function win(x, y) { rect(x, y, W, H, { bg: WHITE, stroke: INK, sw: 1.6 }); }

// vault-level shell: header + grouped sidebar + content. returns content box.
function chrome(x, y, o) {
  win(x, y);
  rect(x, y, W, HB, { bg: WHITE, stroke: LINE, sw: 1, round: false });
  dia(x + 8, y + 6, 13, 13, { bg: VIOBG, stroke: VIO, sw: 1.4 });
  txt(x + 27, y + 8, 'dreamcontext', { size: 9.5 });
  rect(x + 112, y + 6, 66, 14, { bg: TODOBG, stroke: TODO, sw: 1 }); txt(x + 116, y + 9, '◑ Sleepy (5)', { size: 7, color: '#c25500' });
  txt(x + W - 168, y + 9, '−  92%  +', { size: 8, color: MUTED });
  txt(x + W - 108, y + 8, '☾', { size: 10, color: MUTED });
  rect(x + W - 90, y + 6, 50, 14, { bg: DONEBG, stroke: DONE, sw: 1 }); txt(x + W - 85, y + 9, '◐ A11y', { size: 7.5, color: DONE });
  rect(x, y + HB, SB, H - HB, { bg: SIDE, stroke: LINE, sw: 1, round: false });
  // vault switcher pill at top of sidebar
  rect(x + 6, y + HB + 5, SB - 12, 16, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(x + 10, y + HB + 9, '▾ my-app', { size: 7.5, color: MAG });
  const item = (nx, ny, label, on) => { if (on) rect(nx + 4, ny - 2, SB - 9, 13, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(nx + 8, ny, label, { size: 8, color: on ? VIO : '#4b5161' }); };
  const grp = (ny, label) => { txt(x + 8, ny, label, { size: 6.2, color: FAINT }); return ny + 11; };
  let ny = grp(y + HB + 28, 'WORKSPACE');
  ['◎ Overview', '◉ Brain', '▦ Tasks', '✦ Knowledge', '⚑ Features', '◈ Core', '⚔ Council', '◆ Taxonomy', '◑ Sleep'].forEach((l) => { item(x, ny, l, l.slice(2) === o.active); ny += 13.4; });
  ny = grp(ny + 3, 'FEDERATION');
  ['⇄ Connections', '✉ Inbox'].forEach((l) => { item(x, ny, l, l.slice(2) === o.active); ny += 13.4; });
  ny = grp(ny + 3, 'CONTROL');
  ['◳ Packs', '⚙ Settings'].forEach((l) => { item(x, ny, l, l.slice(2) === o.active); ny += 13.4; });
  item(x, y + H - 30, '◐ Accessibility', o.active === 'Accessibility');
  item(x, y + H - 15, '✷ About', o.active === 'About');
  const cx = x + SB, cy = y + HB;
  if (o.title) txt(cx + 12, cy + 10, o.title, { size: 13 });
  return { cx, cy: cy + (o.title ? 30 : 8), cw: W - SB, ch: H - HB - (o.title ? 30 : 8) };
}
function head(x, y, t) { txt(x, y, t, { size: 28, color: INK }); }
function cap(x, y, t, w) { txt(x, y, t, { size: 10, color: MUTED, width: w || 360 }); }

// =====================================================================
// A — APP SHELL HOME (new, above any vault)
// =====================================================================
function Launcher(x, y) {
  win(x, y);
  rect(x, y, W, 34, { bg: WHITE, stroke: LINE, sw: 1, round: false });
  dia(x + 10, y + 9, 15, 15, { bg: VIOBG, stroke: VIO, sw: 1.4 });
  txt(x + 32, y + 12, 'dreamcontext — Projects', { size: 12 });
  rect(x + 192, y + 8, 80, 18, { bg: SIDE, stroke: LINE, sw: 1 }); txt(x + 198, y + 13, '⌕ search', { size: 8, color: FAINT });
  rect(x + W - 156, y + 8, 82, 18, { bg: VIO, stroke: VIO, sw: 1 }); txt(x + W - 150, y + 13, '+ Open Project', { size: 8, color: WHITE });
  rect(x + W - 68, y + 8, 52, 18, { bg: WHITE, stroke: LINE, sw: 1 }); txt(x + W - 62, y + 13, 'Discover', { size: 8 });
  const cards = [['my-app', 'open', false], ['research-notes', 'open', true], ['marketing-site', 'open', false], ['client-x', 'stale', false], ['side-quest', 'open', false], ['archive-2025', 'open', false]];
  let i = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const cx = x + 16 + c * 128, cy = y + 48 + r * 126, cw = 118, chh = 112;
    const [name, st, brain] = cards[i++];
    rect(cx, cy, cw, chh, { bg: WHITE, stroke: brain ? MAG : LINE, sw: brain ? 1.8 : 1 });
    ell(cx + 12, cy + 13, 9, 9, { bg: st === 'stale' ? ERRBG : DONEBG, stroke: st === 'stale' ? ERR : DONE, sw: 1 });
    txt(cx + 27, cy + 13, name, { size: 9.5 });
    txt(cx + 12, cy + 34, '~/projects/' + name, { size: 6.5, color: FAINT, width: cw - 22 });
    chip(cx + 12, cy + 52, '12 tasks', {}); chip(cx + 62, cy + 52, '34 know', {});
    if (brain) { rect(cx + 12, cy + 80, 96, 20, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(cx + 17, cy + 86, '★ Second brain', { size: 8, color: MAG }); }
    else { rect(cx + 12, cy + 80, 44, 20, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(cx + 19, cy + 86, 'Open', { size: 8, color: VIO }); }
  }
}

function OpenProject(x, y) {
  win(x, y);
  rect(x, y, W, 26, { bg: WHITE, stroke: LINE, sw: 1, round: false });
  txt(x + 12, y + 8, 'Open Project — browse Mac filesystem', { size: 10 });
  rect(x, y + 26, 122, H - 26 - 40, { bg: SIDE, stroke: LINE, sw: 1, round: false });
  ['☰ Favorites', '   Desktop', '   Documents', '   projects', '☰ Locations', '   Macintosh HD', '   iCloud Drive'].forEach((p, k) => txt(x + 10, y + 36 + k * 18, p, { size: 8, color: p.startsWith('☰') ? INK : '#4b5161' }));
  rect(x + 122, y + 26, W - 122, H - 26 - 40, { bg: WHITE, stroke: LINE, sw: 1, round: false });
  const rows = [['📁 my-app', true], ['📁 marketing-site', true], ['📁 raw-scripts', false], ['📄 README.md', false], ['📁 experiments', false]];
  rows.forEach(([n, ok], k) => { const ry = y + 36 + k * 22; txt(x + 134, ry, n, { size: 9 }); if (ok) chip(x + 300, ry - 1, '_dream_context ✓', { bg: DONEBG, stroke: DONE, color: DONE, w: 92 }); });
  rect(x, y + H - 40, W, 40, { bg: SIDE, stroke: LINE, sw: 1, round: false });
  rect(x + 12, y + H - 30, 232, 20, { bg: WHITE, stroke: LINE, sw: 1 }); txt(x + 18, y + H - 25, '/Users/me/projects/my-app', { size: 8, color: MUTED });
  rect(x + W - 132, y + H - 30, 120, 20, { bg: VIO, stroke: VIO, sw: 1 }); txt(x + W - 126, y + H - 25, 'Register as Vault', { size: 8.5, color: WHITE });
}

function BrainPicker(x, y) {
  rect(x, y, W, H, { bg: '#eceef3', stroke: LINE, sw: 1, round: false });
  const mx = x + 52, my = y + 50, mw = W - 104, mh = H - 104;
  rect(mx, my, mw, mh, { bg: WHITE, stroke: INK, sw: 1.6 });
  dia(mx + 16, my + 14, 14, 14, { bg: MAGBG, stroke: MAG, sw: 1.4 });
  txt(mx + 38, my + 16, 'Choose your Second Brain', { size: 13, color: MAG });
  cap(mx + 16, my + 38, 'One project powers accessibility, read-aloud and cross-project recall.', mw - 32);
  [['research-notes', true], ['my-app', false], ['client-x', false]].forEach(([n, sel], k) => { const oy = my + 76 + k * 32; rect(mx + 16, oy, mw - 32, 26, { bg: sel ? MAGBG : WHITE, stroke: sel ? MAG : LINE, sw: 1 }); ell(mx + 26, oy + 8, 11, 11, { bg: sel ? MAG : WHITE, stroke: sel ? MAG : FAINT, sw: 1.4 }); txt(mx + 46, oy + 8, n, { size: 10 }); });
  rect(mx + mw - 198, my + mh - 30, 80, 20, { bg: WHITE, stroke: LINE, sw: 1 }); txt(mx + mw - 186, my + mh - 25, 'Cancel', { size: 9 });
  rect(mx + mw - 110, my + mh - 30, 94, 20, { bg: MAG, stroke: MAG, sw: 1 }); txt(mx + mw - 102, my + mh - 25, 'Set as brain', { size: 9, color: WHITE });
}

function Shell(x, y) {
  const c = chrome(x, y, { active: 'Overview', title: 'Overview' });
  rect(c.cx + 12, c.cy + 4, c.cw - 24, 50, { bg: VIOBG, stroke: VIO, sw: 1 });
  rect(c.cx + 12, c.cy + 62, c.cw - 24, 54, { bg: SIDE, stroke: LINE, sw: 1 });
  rect(c.cx + 12, c.cy + 124, c.cw - 24, 60, { bg: SIDE, stroke: LINE, sw: 1 });
  txt(x - 4, y - 18, 'Vault switcher', { size: 9, color: MAG });
  arrow([[x + 40, y - 6], [x + 44, y + 30]], { color: MAG, sw: 1.5 });
  txt(x - 6, y + H + 6, '3 nav groups + app-wide footer (Accessibility · About) ↑', { size: 9, color: MAG, width: 200 });
  arrow([[x + 46, y + H + 2], [x + 46, y + 250]], { color: MAG, sw: 1.5 });
}

// =====================================================================
// B — WORKSPACE (real pages + new Overview)
// =====================================================================
function Overview(x, y) {
  const c = chrome(x, y, { active: 'Overview', title: 'Overview' });
  const stats = [['Tasks', '12 open', VIO], ['Knowledge', '34', MAG], ['Features', '8', DONE], ['Sleep', '5', TODO]];
  for (let i = 0; i < 4; i++) { const sx = c.cx + 12 + i * 72; rect(sx, c.cy + 2, 66, 42, { bg: SIDE, stroke: LINE, sw: 1 }); txt(sx + 6, c.cy + 8, stats[i][0], { size: 7, color: MUTED }); txt(sx + 6, c.cy + 22, stats[i][1], { size: 13, color: stats[i][2] }); }
  rect(c.cx + 12, c.cy + 52, c.cw - 24, 22, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(c.cx + 18, c.cy + 58, '3 pending federation digests → review in Inbox', { size: 7.5, color: VIO });
  txt(c.cx + 12, c.cy + 84, 'Recent activity', { size: 9 });
  ['task “federation” → done', 'knowledge updated', 'council debate started', 'sleep consolidation'].forEach((t, i) => { rect(c.cx + 12, c.cy + 100 + i * 24, c.cw - 24, 20, { bg: WHITE, stroke: LINE, sw: 1 }); txt(c.cx + 20, c.cy + 105 + i * 24, '• ' + t, { size: 7.5, color: '#4b5161' }); });
}

function Brain(x, y) {
  const c = chrome(x, y, { active: 'Brain', title: 'Brain' });
  txt(c.cx + 52, c.cy + 2, '42/58 nodes · 96 links   ↻ ⚙', { size: 8, color: MUTED });
  rect(c.cx + 10, c.cy + 18, 54, c.ch - 28, { bg: SIDE, stroke: LINE, sw: 1 }); ['filters', 'display', 'forces'].forEach((t, i) => txt(c.cx + 15, c.cy + 24 + i * 14, t, { size: 7, color: FAINT }));
  const gx = c.cx + 76, gy = c.cy + 20;
  const nodes = [[60, 50], [140, 28], [205, 78], [110, 130], [195, 150], [44, 110]], cols = [VIO, MAG, DONE, TODO, REV, '#0ea5b7'];
  [[0, 1], [1, 2], [0, 3], [3, 4], [2, 4], [3, 5], [0, 5]].forEach(([a, b]) => arrow([[gx + nodes[a][0], gy + nodes[a][1]], [gx + nodes[b][0], gy + nodes[b][1]]], { color: LINE, sw: 1 }));
  nodes.forEach((n, i) => ell(gx + n[0] - 9, gy + n[1] - 9, 18, 18, { bg: WHITE, stroke: cols[i], sw: 1.6 }));
  rect(c.cx + c.cw - 60, c.cy + 18, 50, c.ch - 28, { bg: SIDE, stroke: LINE, sw: 1 }); txt(c.cx + c.cw - 55, c.cy + 24, 'NodeDrawer', { size: 6.5, color: FAINT });
}

function Tasks(x, y) {
  const c = chrome(x, y, { active: 'Tasks', title: 'Tasks' });
  let tx = c.cx + 52; ['Kanban', 'Priority', 'Urgency', 'Eisenhower', 'RICE'].forEach((v, i) => { tx += chip(tx, c.cy - 26, v, i === 0 ? { bg: VIOBG, stroke: VIO, color: VIO } : {}) + 4; });
  rect(c.cx + 10, c.cy + 2, 118, 14, { bg: SIDE, stroke: LINE, sw: 1 }); txt(c.cx + 14, c.cy + 5, '⌕ search · filters', { size: 7, color: FAINT });
  chip(c.cx + 134, c.cy + 2, 'Saved views ▾', {}); chip(c.cx + 212, c.cy + 2, 'v0.8 ▾', { bg: VIOBG, stroke: VIO, color: VIO });
  rect(c.cx + c.cw - 44, c.cy + 2, 34, 14, { bg: VIO, stroke: VIO, sw: 1 }); txt(c.cx + c.cw - 39, c.cy + 5, '+ New', { size: 7, color: WHITE });
  const cols = [['To do', TODO, TODOBG], ['In progress', VIO, VIOBG], ['In review', REV, REVBG], ['Done', DONE, DONEBG]];
  for (let i = 0; i < 4; i++) { const sx = c.cx + 10 + i * 75; rect(sx, c.cy + 22, 70, c.ch - 32, { bg: SIDE, stroke: LINE, sw: 1 }); rect(sx + 6, c.cy + 28, 42, 12, { bg: cols[i][2], stroke: cols[i][1], sw: 1 }); txt(sx + 9, c.cy + 30, cols[i][0], { size: 6.5, color: cols[i][1] }); for (let k = 0; k < 3 - (i % 2); k++) rect(sx + 6, c.cy + 46 + k * 32, 58, 26, { bg: WHITE, stroke: LINE, sw: 1 }); }
}

function Knowledge(x, y) {
  const c = chrome(x, y, { active: 'Knowledge', title: 'Knowledge' });
  rect(c.cx + 10, c.cy + 2, 104, c.ch - 12, { bg: SIDE, stroke: LINE, sw: 1 });
  [['▾ data-structures', false], ['   schema.sql ◆', true], ['   users.sql', false], ['▸ diagrams (4)', false], ['▸ products (7)', false], ['memory-archive ◇', false]].forEach(([t, on], k) => { const ly = c.cy + 10 + k * 17; if (on) rect(c.cx + 14, ly - 2, 96, 14, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(c.cx + 17, ly + 1, t, { size: 7, color: on ? VIO : '#4b5161' }); });
  rect(c.cx + 122, c.cy + 2, c.cw - 134, c.ch - 12, { bg: WHITE, stroke: LINE, sw: 1 });
  txt(c.cx + 130, c.cy + 8, 'schema.sql', { size: 9 }); chip(c.cx + 196, c.cy + 6, 'File', {}); chip(c.cx + 226, c.cy + 6, 'Preview', { bg: VIOBG, stroke: VIO, color: VIO });
  rect(c.cx + c.cw - 28, c.cy + 6, 16, 14, { bg: SIDE, stroke: LINE, sw: 1 }); txt(c.cx + c.cw - 26, c.cy + 8, '⛶', { size: 9, color: MUTED });
  rect(c.cx + 134, c.cy + 28, 58, 38, { bg: SIDE, stroke: VIO, sw: 1 }); rect(c.cx + 228, c.cy + 28, 58, 38, { bg: SIDE, stroke: VIO, sw: 1 }); arrow([[c.cx + 192, c.cy + 47], [c.cx + 228, c.cy + 47]], { color: VIO, sw: 1 });
  txt(c.cx + 134, c.cy + 74, 'SQL→ER · Excalidraw · mermaid', { size: 7, color: FAINT, width: 160 });
}

function Features(x, y) {
  const c = chrome(x, y, { active: 'Features', title: 'Features' });
  rect(c.cx + 10, c.cy + 2, 116, c.ch - 12, { bg: SIDE, stroke: LINE, sw: 1 });
  [['federation', DONE, 'shipped'], ['unified-dash', VIO, 'in_progress'], ['multi-review', DONE, 'shipped'], ['migration-sys', TODO, 'stale']].forEach(([n, col, st], i) => { const fy = c.cy + 8 + i * 36; rect(c.cx + 14, fy, 108, 30, { bg: i === 1 ? VIOBG : WHITE, stroke: i === 1 ? VIO : LINE, sw: 1 }); txt(c.cx + 18, fy + 4, n, { size: 8 }); chip(c.cx + 18, fy + 16, st, { bg: WHITE, stroke: col, color: col }); });
  rect(c.cx + 134, c.cy + 2, c.cw - 146, c.ch - 12, { bg: WHITE, stroke: LINE, sw: 1 });
  txt(c.cx + 142, c.cy + 8, 'unified-dashboard · PRD', { size: 9 }); txt(c.cx + 142, c.cy + 24, 'Status: in_progress · Updated 2d', { size: 7, color: MUTED });
  for (let i = 0; i < 5; i++) rect(c.cx + 142, c.cy + 40 + i * 18, c.cw - 168, 11, { bg: FOG, stroke: FOG, sw: 0.5 });
}

function Core(x, y) {
  const c = chrome(x, y, { active: 'Core', title: 'Core' });
  rect(c.cx + 10, c.cy + 2, 116, c.ch - 12, { bg: SIDE, stroke: LINE, sw: 1 });
  [['0.soul.md', 'md', true], ['1.user.md', 'md', false], ['2.memory.md', 'md', false], ['4.tech_stack.md', 'md', false], ['CHANGELOG.json', 'json', false], ['RELEASES.json', 'json', false], ['taxonomy.json', 'json', false]].forEach(([n, t, on], k) => { const fy = c.cy + 8 + k * 19; if (on) rect(c.cx + 14, fy - 2, 108, 16, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(c.cx + 18, fy + 1, n, { size: 7.5, color: on ? VIO : INK }); chip(c.cx + 96, fy, t, { w: 22 }); });
  rect(c.cx + 134, c.cy + 2, c.cw - 146, c.ch - 12, { bg: WHITE, stroke: LINE, sw: 1 });
  txt(c.cx + 142, c.cy + 8, '0.soul.md', { size: 9 }); chip(c.cx + 220, c.cy + 6, 'Edit', { bg: VIOBG, stroke: VIO, color: VIO });
  for (let i = 0; i < 6; i++) rect(c.cx + 142, c.cy + 28 + i * 18, c.cw - 168, 11, { bg: FOG, stroke: FOG, sw: 0.5 });
}

function Council(x, y) {
  const c = chrome(x, y, { active: 'Council', title: 'Council' });
  rect(c.cx + 10, c.cy + 2, 110, 14, { bg: SIDE, stroke: LINE, sw: 1 }); txt(c.cx + 14, c.cy + 5, '⌕ topic / persona', { size: 7, color: FAINT }); chip(c.cx + 126, c.cy + 2, 'All ▾', {});
  [['unified-dashboard?', 'running', 'R2/3', false], ['merge strategy', 'complete', 'R3/3', true], ['pricing model', 'synth', 'R2/2', false]].forEach(([topic, st, rd, promoted], k) => {
    const dy = c.cy + 22 + k * 56; rect(c.cx + 10, dy, c.cw - 22, 50, { bg: WHITE, stroke: LINE, sw: 1 });
    ell(c.cx + 18, dy + 8, 8, 8, { bg: st === 'complete' ? DONEBG : st === 'running' ? VIOBG : TODOBG, stroke: st === 'complete' ? DONE : st === 'running' ? VIO : TODO, sw: 1 });
    txt(c.cx + 32, dy + 7, topic, { size: 8.5 }); chip(c.cx + c.cw - 52, dy + 6, rd, {});
    for (let m = 0; m < 4; m++) ell(c.cx + 20 + m * 16, dy + 26, 13, 13, { bg: MAGBG, stroke: MAG, sw: 1 });
    if (promoted) chip(c.cx + 100, dy + 28, '★ promoted', { bg: DONEBG, stroke: DONE, color: DONE });
  });
}

function Taxonomy(x, y) {
  const c = chrome(x, y, { active: 'Taxonomy', title: 'Taxonomy' });
  [['domain', [VIO, DONE, TODO]], ['layer', [REV, MAG]], ['kind', [DONE, VIO, '#0ea5b7']], ['topic', [TODO, MAG, VIO]]].forEach(([name, cols], k) => { const fy = c.cy + 4 + k * 22; txt(c.cx + 12, fy, name, { size: 8, color: MUTED }); let cxp = c.cx + 70; cols.forEach((col, i) => { cxp += chip(cxp, fy - 1, 'tag·' + (i + 3), { bg: WHITE, stroke: col, color: col }) + 5; }); });
  const fy = c.cy + 4 + 4 * 22; rect(c.cx + 12, fy + 4, c.cw - 24, 40, { bg: DONEBG, stroke: DONE, sw: 1 }); txt(c.cx + 18, fy + 10, '✓ Drift audit — no issues', { size: 9, color: DONE }); txt(c.cx + 18, fy + 24, 'untagged · non-canonical · orphans · near-dupes', { size: 7, color: '#2b8a3e' });
}

function Sleep(x, y) {
  const c = chrome(x, y, { active: 'Sleep', title: 'Sleep' });
  ell(c.cx + 12, c.cy + 6, 56, 56, { bg: TODOBG, stroke: TODO, sw: 1.6 }); txt(c.cx + 33, c.cy + 22, '5', { size: 20, color: '#c25500' }); txt(c.cx + 16, c.cy + 66, 'Sleepy', { size: 8, color: TODO });
  txt(c.cx + 84, c.cy + 10, 'Last sleep: 2026-06-12', { size: 8, color: MUTED }); txt(c.cx + 84, c.cy + 26, 'consolidation 2026-06-12…', { size: 8, color: FAINT, width: 200 });
  chip(c.cx + 84, c.cy + 46, '3 pending', { bg: VIOBG, stroke: VIO, color: VIO });
  txt(c.cx + 12, c.cy + 86, 'Changelog', { size: 9 });
  ['federation mesh', 'harden overlay', 'sleep consolidation'].forEach((t, i) => { rect(c.cx + 12, c.cy + 102 + i * 26, c.cw - 24, 22, { bg: WHITE, stroke: LINE, sw: 1 }); chip(c.cx + 18, c.cy + 106 + i * 26, ['feat', 'fix', 'chore'][i], { bg: VIOBG, stroke: VIO, color: VIO }); txt(c.cx + 56, c.cy + 107 + i * 26, t, { size: 7.5, color: '#4b5161' }); });
}

// ---- FEDERATION (promoted to top-level) ----
function Connections(x, y) {
  const c = chrome(x, y, { active: 'Connections', title: 'Connections' });
  rect(c.cx + 12, c.cy + 2, c.cw - 24, 26, { bg: DONEBG, stroke: DONE, sw: 1 }); txt(c.cx + 18, c.cy + 9, 'Shareable — discoverable by peers', { size: 8, color: DONE });
  rect(c.cx + c.cw - 46, c.cy + 7, 30, 14, { bg: DONE, stroke: DONE, sw: 1 }); ell(c.cx + c.cw - 32, c.cy + 8, 11, 11, { bg: WHITE, stroke: DONE, sw: 1 });
  [['research-notes', '⇄'], ['marketing-site', '→'], ['client-x', '←']].forEach(([peer, dir], i) => { const ry = c.cy + 38 + i * 34; rect(c.cx + 12, ry, c.cw - 24, 28, { bg: WHITE, stroke: LINE, sw: 1 }); chip(c.cx + 18, ry + 7, 'my-app', { bg: MAGBG, stroke: MAG, color: MAG }); txt(c.cx + 74, ry + 7, dir, { size: 13, color: MAG }); chip(c.cx + 96, ry + 7, peer, {}); chip(c.cx + c.cw - 78, ry + 7, 'in / out / both', { w: 64 }); });
  rect(c.cx + 12, c.cy + 38 + 3 * 34, 108, 20, { bg: VIO, stroke: VIO, sw: 1 }); txt(c.cx + 20, c.cy + 42 + 3 * 34, '+ Add connection', { size: 8, color: WHITE });
}

function Inbox(x, y) {
  const c = chrome(x, y, { active: 'Inbox', title: 'Inbox' });
  rect(c.cx + c.cw - 150, c.cy + 2, 138, 20, { bg: TODOBG, stroke: TODO, sw: 1 }); txt(c.cx + c.cw - 144, c.cy + 7, 'Sync preview (dry-run)', { size: 8, color: '#c25500' });
  for (let i = 0; i < 3; i++) { const ry = c.cy + 30 + i * 56; rect(c.cx + 12, ry, c.cw - 24, 48, { bg: WHITE, stroke: LINE, sw: 1 }); chip(c.cx + 18, ry + 8, 'from research-notes', { bg: MAGBG, stroke: MAG, color: MAG, w: 98 }); txt(c.cx + 18, ry + 28, 'digest: “prompt-caching pattern…”', { size: 7.5, color: '#4b5161' }); rect(c.cx + c.cw - 130, ry + 14, 54, 18, { bg: DONEBG, stroke: DONE, sw: 1 }); txt(c.cx + c.cw - 124, ry + 18, 'Ingest', { size: 8, color: DONE }); rect(c.cx + c.cw - 72, ry + 14, 56, 18, { bg: WHITE, stroke: LINE, sw: 1 }); txt(c.cx + c.cw - 66, ry + 18, 'Ignore', { size: 8, color: MUTED }); }
}

// =====================================================================
// CONTROL + APP-WIDE
// =====================================================================
function Packs(x, y) {
  const c = chrome(x, y, { active: 'Packs', title: 'Packs' });
  for (let i = 0; i < 6; i++) { const px = c.cx + 12 + (i % 3) * 96, py = c.cy + 6 + Math.floor(i / 3) * 96; rect(px, py, 88, 86, { bg: WHITE, stroke: LINE, sw: 1 }); rect(px + 10, py + 8, 30, 24, { bg: SIDE, stroke: LINE, sw: 1 }); txt(px + 46, py + 12, ['design', 'engineering', 'growth', 'council', 'meet', 'excalidraw'][i], { size: 7 }); const inst = i < 3; rect(px + 10, py + 60, 68, 18, { bg: inst ? DONEBG : VIO, stroke: inst ? DONE : VIO, sw: 1 }); txt(px + 16, py + 64, inst ? '✓ Installed' : 'Install', { size: 7.5, color: inst ? DONE : WHITE }); }
}

function Settings(x, y) {
  const c = chrome(x, y, { active: 'Settings', title: 'Settings' });
  rect(c.cx + c.cw - 50, c.cy - 26, 38, 16, { bg: VIO, stroke: VIO, sw: 1 }); txt(c.cx + c.cw - 44, c.cy - 22, 'Save', { size: 8, color: WHITE });
  txt(c.cx + 12, c.cy + 2, 'Platforms', { size: 8.5, color: MUTED }); for (let i = 0; i < 1; i++) { rect(c.cx + 14, c.cy + 16 + i * 16, 10, 10, { bg: VIO, stroke: VIO, sw: 1 }); txt(c.cx + 30, c.cy + 15 + i * 16, ['Claude'][i], { size: 8 }); }
  txt(c.cx + 12, c.cy + 52, 'Tasks', { size: 8.5, color: MUTED }); rect(c.cx + 14, c.cy + 66, 10, 10, { bg: WHITE, stroke: LINE, sw: 1 }); txt(c.cx + 30, c.cy + 65, 'Enable cloud tasks (ClickUp)', { size: 8 });
  txt(c.cx + 12, c.cy + 86, 'Memory', { size: 8.5, color: MUTED }); rect(c.cx + 14, c.cy + 100, 10, 10, { bg: VIO, stroke: VIO, sw: 1 }); txt(c.cx + 30, c.cy + 99, 'Disable native memory', { size: 8 });
  rect(c.cx + 12, c.cy + 122, c.cw - 24, 22, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(c.cx + 18, c.cy + 128, 'Federation → moved to Connections & Inbox', { size: 7.5, color: MAG });
}

function Accessibility(x, y) {
  const c = chrome(x, y, { active: 'Accessibility', title: 'Accessibility' });
  rect(c.cx + 12, c.cy + 2, c.cw - 24, 24, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(c.cx + 20, c.cy + 8, '★ Second brain: research-notes', { size: 8.5, color: MAG });
  [['Text size', 'slider'], ['High contrast', 'on'], ['Reduced motion', 'on'], ['Dyslexia-friendly font', 'off'], ['Screen-reader mode', 'on'], ['Color-blind palette', 'select'], ['Read-aloud voice', 'select']].forEach(([label, t], k) => { const ry = c.cy + 34 + k * 25; txt(c.cx + 16, ry, label, { size: 8.5 }); if (t === 'slider') { rect(c.cx + c.cw - 92, ry + 4, 76, 5, { bg: FOG, stroke: LINE, sw: 1, round: false }); ell(c.cx + c.cw - 56, ry, 11, 11, { bg: DONE, stroke: DONE, sw: 1 }); } else if (t === 'select') { rect(c.cx + c.cw - 92, ry - 2, 76, 15, { bg: WHITE, stroke: LINE, sw: 1 }); txt(c.cx + c.cw - 86, ry + 1, '▾ choose', { size: 7, color: FAINT }); } else { const on = t === 'on'; rect(c.cx + c.cw - 48, ry - 2, 28, 15, { bg: on ? DONE : FOG, stroke: on ? DONE : LINE, sw: 1 }); ell(on ? c.cx + c.cw - 33 : c.cx + c.cw - 47, ry - 1, 12, 12, { bg: WHITE, stroke: on ? DONE : FAINT, sw: 1 }); } });
}

function Focus(x, y) {
  win(x, y);
  rect(x, y, W, 26, { bg: MAGBG, stroke: MAG, sw: 1, round: false }); txt(x + 12, y + 8, 'Focus mode · powered by Second Brain', { size: 10, color: MAG }); txt(x + W - 56, y + 8, '✕ exit', { size: 9, color: MAG });
  txt(x + 44, y + 56, 'Prompt caching', { size: 22 });
  for (let i = 0; i < 4; i++) rect(x + 44, y + 96 + i * 22, W - 88, 12, { bg: FOG, stroke: FOG, sw: 0.5 });
  ell(x + 44, y + 200, 30, 30, { bg: DONEBG, stroke: DONE, sw: 1.5 }); txt(x + 54, y + 208, '▶', { size: 12, color: DONE });
  rect(x + 84, y + 209, 150, 12, { bg: FOG, stroke: LINE, sw: 1, round: false }); ell(x + 154, y + 206, 10, 10, { bg: DONE, stroke: DONE, sw: 1 });
  txt(x + 44, y + 238, 'Read-aloud · large type · high contrast', { size: 8.5, color: MUTED });
  rect(x + 44, y + H - 42, W - 88, 26, { bg: WHITE, stroke: MAG, sw: 1.4 }); txt(x + 56, y + H - 34, 'Ask your second brain…', { size: 9, color: FAINT });
  ell(x + W - 70, y + H - 40, 22, 22, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(x + W - 64, y + H - 34, '🎤', { size: 10 });
}

function About(x, y) {
  const c = chrome(x, y, { active: 'About', title: 'About' });
  rect(c.cx + 12, c.cy + 2, c.cw - 24, 44, { bg: VIOBG, stroke: VIO, sw: 1 }); txt(c.cx + 20, c.cy + 11, 'dreamcontext', { size: 14, color: VIO }); txt(c.cx + 20, c.cy + 29, 'the persistent brain for your AI agents', { size: 8, color: MUTED });
  ['Problem', 'How it works', 'Sleep flow', 'Recall flow', 'Architecture'].forEach((s, i) => { const sy = c.cy + 54 + i * 22; rect(c.cx + 12, sy, c.cw - 24, 18, { bg: SIDE, stroke: LINE, sw: 1 }); txt(c.cx + 18, sy + 4, s, { size: 8 }); });
  let mx = c.cx + 12; ['design', 'eng', 'growth', 'council'].forEach((p) => { mx += chip(mx, c.cy + 54 + 5 * 22 + 4, p, { bg: WHITE, stroke: VIO, color: VIO }) + 4; });
}

// =====================================================================
// D — QUICK CAPTURE & NOTCH ASSISTANT (new — "press fn to teach the brain")
// =====================================================================
const line = (pts, o = {}) => E.push({ type: 'line', points: pts, strokeColor: o.color || INK, strokeWidth: o.sw || 2 });
function mascot(cx, cy, s) { ell(cx - s * 1.4, cy - s * 0.6, s, s * 1.3, { bg: WHITE, stroke: WHITE, sw: 1 }); ell(cx + s * 0.4, cy - s * 0.6, s, s * 1.3, { bg: WHITE, stroke: WHITE, sw: 1 }); line([[cx - s, cy + s * 0.9], [cx, cy + s * 1.3], [cx + s, cy + s * 0.9]], { color: WHITE, sw: 1.6 }); }

function QuickCapture(x, y) {
  rect(x, y, W, H, { bg: '#36306b', stroke: INK, sw: 1.6, round: false });
  rect(x, y, W, 14, { bg: '#15151c', stroke: '#15151c', sw: 0, round: false });
  rect(x + W / 2 - 32, y, 64, 20, { bg: '#0a0a0a', stroke: '#0a0a0a', sw: 0, round: false });
  mascot(x + W / 2, y + 8, 5);
  const bx = x + W / 2 - 156, by = y + 24, bw = 312;
  rect(bx, by, bw, 58, { bg: '#16161e', stroke: MAG, sw: 1.6 });
  rect(bx + 12, by + 10, bw - 24, 18, { bg: '#23232c', stroke: '#2f2f3a', sw: 1 });
  txt(bx + 18, by + 14, 'Type a note, paste a link or image — or a command…', { size: 7.5, color: '#aeb2c0' });
  ell(bx + bw - 28, by + 11, 15, 15, { bg: MAGBG, stroke: MAG, sw: 1 }); txt(bx + bw - 25, by + 14, '🎤', { size: 8 });
  chip(bx + 12, by + 34, '→ research-notes ▾', { bg: MAGBG, stroke: MAG, color: MAG, w: 100 });
  rect(bx + bw - 104, by + 33, 92, 16, { bg: MAG, stroke: MAG, sw: 1 }); txt(bx + bw - 98, by + 37, '⏎ Save to brain', { size: 7.5, color: WHITE });
  rect(x + W / 2 - 78, y + 94, 156, 18, { bg: 'transparent', stroke: '#ffffff', sw: 1 }); txt(x + W / 2 - 70, y + 98, 'press  fn  anywhere on macOS', { size: 7.5, color: WHITE });
  txt(x + 14, y + H - 20, 'Global hotkey → quick-capture into the Second Brain (Tauri global shortcut + notch window).', { size: 8, color: '#dfe2ea', width: W - 28 });
}

function NotchMascot(x, y) {
  rect(x, y, W, H, { bg: '#2b2550', stroke: INK, sw: 1.6, round: false });
  rect(x, y, W, 14, { bg: '#15151c', stroke: '#15151c', sw: 0, round: false });
  rect(x + W / 2 - 40, y, 80, 24, { bg: '#0a0a0a', stroke: '#0a0a0a', sw: 0, round: false });
  mascot(x + W / 2 - 6, y + 9, 6);
  ell(x + W / 2 + 26, y + 1, 13, 13, { bg: MAG, stroke: MAG, sw: 1 }); txt(x + W / 2 + 30, y + 3, '3', { size: 7, color: WHITE });
  const mx = x + W / 2 - 72, my = y + 30;
  rect(mx, my, 146, 86, { bg: '#16161e', stroke: '#2f2f3a', sw: 1.2 });
  ['⌨  Quick capture (fn)', '☑  Review · 3 to call', '◳  Open dashboard', '◑  Sleep status'].forEach((t, i) => txt(mx + 10, my + 12 + i * 18, t, { size: 8, color: '#dfe2ea' }));
  txt(x + 16, y + 138, 'Mascot lives in the notch — the brain’s face:', { size: 8, color: WHITE });
  ['😊  idle / alert', '●  N to review  (badge)', '◑  sleepy  (mirrors sleep debt)'].forEach((t, i) => { rect(x + 16, y + 156 + i * 28, W - 32, 22, { bg: WHITE, stroke: LINE, sw: 1 }); txt(x + 24, y + 161 + i * 28, t, { size: 8 }); });
}

function CaptureFeed(x, y) {
  win(x, y);
  rect(x, y, W, 26, { bg: WHITE, stroke: LINE, sw: 1, round: false });
  txt(x + 12, y + 8, '← back', { size: 8, color: MUTED });
  let tcx = x + 66; ['☑ 14', '✦ 10', '🔔 3', '✉ 10+'].forEach((t) => { tcx += chip(tcx, y + 6, t) + 4; });
  rect(x + W - 150, y + 6, 138, 14, { bg: TODOBG, stroke: TODO, sw: 1 }); txt(x + W - 144, y + 9, 'Review · 12 need review', { size: 7, color: '#c25500' });
  txt(x + 14, y + 36, 'TODAY · 16:12', { size: 7.5, color: FAINT });
  rect(x + 14, y + 48, W - 28, 66, { bg: SIDE, stroke: LINE, sw: 1 });
  txt(x + 22, y + 54, 'Captured note: “Taby stays on after shutdown — add AFK timeout?”', { size: 8, color: '#4b5161', width: W - 60 });
  let ax = x + 22; [['→ Task', VIO], ['→ Knowledge', MAG], ['Schedule', TODO], ['Dismiss', MUTED]].forEach(([t, col]) => { ax += chip(ax, y + 92, t, { bg: WHITE, stroke: col, color: col }) + 4; });
  rect(x + 14, y + 122, W - 28, 44, { bg: SIDE, stroke: LINE, sw: 1 });
  txt(x + 22, y + 128, '🔗 pasted link · github.com/anthropics/…', { size: 8, color: '#4b5161' });
  let bx2 = x + 22; [['→ Knowledge', MAG], ['Dismiss', MUTED]].forEach(([t, col]) => { bx2 += chip(bx2, y + 146, t, { bg: WHITE, stroke: col, color: col }) + 4; });
  rect(x + 14, y + H - 40, W - 28, 26, { bg: WHITE, stroke: MAG, sw: 1.3 }); txt(x + 24, y + H - 32, 'Write a note, paste a link or image…', { size: 8.5, color: FAINT });
  chip(x + W - 122, y + H - 36, 'Folder ▾', {}); rect(x + W - 56, y + H - 37, 42, 16, { bg: MAG, stroke: MAG, sw: 1 }); txt(x + W - 50, y + H - 33, 'Save', { size: 8, color: WHITE });
}

// =====================================================================
// LAYOUT
// =====================================================================
function place(id, fn, col, rowY, caption) { const x = COLX[col], y = rowY; B[id] = { x, y, cx: x + W / 2, cy: y + H / 2 }; fn(x, y); if (caption) txt(x, y - 18, caption, { size: 10, color: MUTED, width: W }); }
const RA = 84, RB1 = 620, RB2 = 1080, RB3 = 1540, RC = 2080, RD = 2540, RE = 3020;

head(60, 18, 'A · App shell home  (new — above any vault)');
place('A1', Launcher, 0, RA, 'Launcher · all projects'); place('A2', OpenProject, 1, RA, 'Open project · macOS FS'); place('A3', BrainPicker, 2, RA, 'Second-brain picker'); place('A4', Shell, 3, RA, 'App shell (combined nav)');

head(60, RB1 - 58, 'B · Workspace  (Overview + the real dashboard pages)');
place('Overview', Overview, 0, RB1, 'Overview · vault home (new)'); place('Brain', Brain, 1, RB1, 'Brain · graph'); place('Tasks', Tasks, 2, RB1, 'Tasks · 5 views'); place('Knowledge', Knowledge, 3, RB1, 'Knowledge');
place('Features', Features, 0, RB2, 'Features'); place('Core', Core, 1, RB2, 'Core'); place('Council', Council, 2, RB2, 'Council'); place('Taxonomy', Taxonomy, 3, RB2, 'Taxonomy');
place('Sleep', Sleep, 0, RB3, 'Sleep');
head(COLX[1], RB3 - 58, 'Federation  (promoted)');
place('Connections', Connections, 1, RB3, 'Connections'); place('Inbox', Inbox, 2, RB3, 'Inbox');

head(60, RC - 58, 'C · Control panel + Accessibility  (app-wide)');
place('Packs', Packs, 0, RC, 'Packs'); place('Settings', Settings, 1, RC, 'Settings'); place('Accessibility', Accessibility, 2, RC, 'Accessibility center'); place('Focus', Focus, 3, RC, 'Focus · read-aloud · voice');
place('About', About, 0, RD, 'About');

head(60, RE - 58, 'D · Quick Capture & Notch Assistant  (new — “press fn to teach the brain”, inspired by Taby)');
place('QC1', QuickCapture, 0, RE, 'Quick capture (fn) · global hotkey'); place('QC2', NotchMascot, 1, RE, 'Notch mascot · states & menu'); place('QC3', CaptureFeed, 2, RE, 'Capture feed · “Needs your call” / Review');
arrow([[B.QC1.x + W, B.QC1.cy], [B.QC3.x, B.QC3.cy]], { color: MAG }); txt(B.QC1.x + W + 6, B.QC1.cy - 16, 'lands in the brain’s feed →', { size: 9, color: MAG, width: 120 });

// legend
const lx = COLX[1], ly = RD - 4;
rect(lx, ly, 1180, 132, { bg: '#fcfcfd', stroke: LINE, sw: 1 });
txt(lx + 14, ly + 12, 'Legend & primary flows', { size: 12 });
[[VIO, VIOBG, 'accent / in-progress'], [MAG, MAGBG, 'second brain / federation'], [DONE, DONEBG, 'done / accessibility'], [TODO, TODOBG, 'todo / caution'], [REV, REVBG, 'in-review'], [ERR, ERRBG, 'stale / risk']].forEach((l, i) => { rect(lx + 14 + (i % 3) * 300, ly + 36 + Math.floor(i / 3) * 22, 14, 14, { bg: l[1], stroke: l[0], sw: 1 }); txt(lx + 34 + (i % 3) * 300, ly + 38 + Math.floor(i / 3) * 22, l[2], { size: 9 }); });
txt(lx + 14, ly + 90, 'IA: App home (Launcher/Open/Second-brain) → vault sidebar [WORKSPACE · FEDERATION · CONTROL] + footer [Accessibility · About].', { size: 9, color: MUTED, width: 1150 });
txt(lx + 14, ly + 108, 'Flows: Launcher → Open Project → Register → Enter vault → Overview.   Launcher → Second-brain picker → Accessibility.', { size: 9, color: MUTED, width: 1150 });

// flow arrows
arrow([[B.A1.x + W, B.A1.cy], [B.A2.x, B.A2.cy]], { color: VIO }); txt(B.A1.x + W + 6, B.A1.cy - 16, 'Open Project', { size: 9, color: VIO });
arrow([[B.A2.x + W, B.A2.cy], [B.A3.x, B.A3.cy]], { color: DONE }); txt(B.A2.x + W + 6, B.A2.cy - 16, 'Register → pick', { size: 9, color: DONE });
arrow([[B.A1.cx, B.A1.y + H], [B.Overview.cx, B.Overview.y]], { color: FAINT }); txt(B.A1.cx + 6, B.A1.y + H + 8, 'Enter vault → Overview', { size: 9, color: MUTED });
arrow([[B.A3.cx, B.A3.y + H], [B.Accessibility.x + W / 2, B.Accessibility.y]], { color: MAG }); txt(B.A3.cx + 6, B.A3.y + H + 10, 'sets accessibility source', { size: 9, color: MAG });

buildExcalidraw({ out: path.resolve(__dirname, '../../_dream_context/inbox/unified-dashboard-wireframes.excalidraw.md'), background: '#ffffff', elements: E });
