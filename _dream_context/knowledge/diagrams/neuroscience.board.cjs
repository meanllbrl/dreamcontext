// dreamcontext "neuroscience-inspired memory" board — two-stage model mapped to the system.
const path = require('node:path');
const { buildExcalidraw } = require('../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  rightOf, leftOf, bottomOf, topOf,
} = require('../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'neuroscience.excalidraw.md');
const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'Two-stage memory — brain → dreamcontext', fontSize: 34 }));

const BRAIN_X = 80, SYS_X = 620, W = 380, H = 96;
const AWAKE_Y = 120, SLEEP_Y = 320;

els.push(...sectionTitle({ x: 80, y: 78, text: 'The brain', fontSize: 20 }));
els.push(...sectionTitle({ x: 620, y: 78, text: 'dreamcontext', fontSize: 20 }));

// Awake row
const bAwake = { x: BRAIN_X, y: AWAKE_Y, w: W, h: H };
els.push(...card({ ...bAwake, color: 'yellow', fontSize: 17, text: 'Awake sharp-wave ripples\ntag salient moments as they happen' }));
const sAwake = { x: SYS_X, y: AWAKE_Y, w: W, h: H };
els.push(...card({ ...sAwake, color: 'blue', fontSize: 17, text: 'Bookmarks\nsalience ★ ★★ ★★★ during the session' }));
els.push(...connector({ from: rightOf(bAwake.x, bAwake.y, bAwake.w, bAwake.h), to: leftOf(sAwake.x, sAwake.y, sAwake.w, sAwake.h), label: 'maps to' }));

// Sleep row
const bSleep = { x: BRAIN_X, y: SLEEP_Y, w: W, h: H };
els.push(...card({ ...bSleep, color: 'purple', fontSize: 17, text: 'Sleep replay\nhippocampus → neocortex transfer' }));
const sSleep = { x: SYS_X, y: SLEEP_Y, w: W, h: H };
els.push(...card({ ...sSleep, color: 'mint', fontSize: 17, text: 'RemSleep consolidation\nstate/ → core/ + knowledge/' }));
els.push(...connector({ from: rightOf(bSleep.x, bSleep.y, bSleep.w, bSleep.h), to: leftOf(sSleep.x, sSleep.y, sSleep.w, sSleep.h), label: 'maps to' }));

// time arrow: awake → asleep (on the system side)
els.push(...connector({ from: bottomOf(sAwake.x, sAwake.y, sAwake.w, sAwake.h), to: topOf(sSleep.x, sSleep.y, sSleep.w, sSleep.h), label: 'debt builds → sleep' }));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
