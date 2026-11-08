// style_board.js — house-style demo. Run from anywhere:  node examples/style_board.js
// Shows card/connector/sectionTitle + the dimension-aware lane() (captions hug images, .nextY stacks).
const path = require('path');
const { buildExcalidraw, lane } = require(path.join(__dirname, '..', 'scripts', 'build_excalidraw.js'));
const { card, connector, sectionTitle, rightOf, leftOf, bottomOf, topOf } = require(path.join(__dirname, '..', 'scripts', 'lib', 'style.js'));

const SAMPLE = path.join(__dirname, 'sample.png');
const els = [];
const P = (...a) => els.push(...a.flat());

// --- flow row with labeled connectors (color nodes by role) ---
P(sectionTitle({ x: 0, y: 0, text: 'House style', fontSize: 40 }));
const A = { x: 0, y: 90, w: 220, h: 84 }, B = { x: 360, y: 90, w: 220, h: 84 }, C = { x: 720, y: 90, w: 220, h: 84 };
P(card({ ...A, text: 'input', color: 'blue' }));
P(card({ ...B, text: 'core service', color: 'purple' }));
P(card({ ...C, text: 'result', color: 'mint' }));
P(connector({ from: rightOf(A.x, A.y, A.w, A.h), to: leftOf(B.x, B.y, B.w, B.h), label: 'request' }));
P(connector({ from: rightOf(B.x, B.y, B.w, B.h), to: leftOf(C.x, C.y, C.w, C.h), label: 'response' }));

// --- a dimension-aware lane: captions hug each image, .nextY gives the next free row ---
const imgs = [
  { path: SAMPLE, caption: 'lane() reads the real image size, so this caption hugs the bottom and wraps to the thumb width — no gap, no overlap.' },
  { path: SAMPLE, caption: 'second thumb' },
  { path: SAMPLE, caption: 'third thumb' },
];
const strip = lane({ title: 'lane()  — funnel-step style strip', images: imgs, x: 0, y: 220, thumbW: 200 });
P(strip);
P(sectionTitle({ x: 0, y: strip.nextY, text: 'stacked below via strip.nextY', fontSize: 22, color: '#868e96' }));

buildExcalidraw({ out: path.join(__dirname, 'Style Demo.excalidraw.md'), elements: els, background: '#fbfbfb' });
console.log('style demo →', path.join(__dirname, 'Style Demo.excalidraw.md'));
