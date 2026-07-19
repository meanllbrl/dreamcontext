#!/usr/bin/env node
// Live Excalidraw-style viewer for a goal-skill v2 run.
// Serves a hand-drawn animated graph of _dream_context/tmp/.goal-skill-live.json
// (the same state file the app's live panel reads — single writer: the orchestrator).
//   node .claude/goal-skill-viewer.cjs [port]     default port 4747
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.argv[2]) || 4747;
const STATE = path.join(process.cwd(), '_dream_context', 'tmp', '.goal-skill-live.json');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>goal-skill live</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#121217; color:#e8e8ec; font-family:'Chalkboard SE','Comic Sans MS','Segoe Print',cursive;
         display:flex; flex-direction:column; align-items:center; min-height:100vh; }
  header { display:flex; gap:14px; align-items:baseline; padding:18px 0 0; }
  header .mark { color:#b197fc; font-size:22px; font-weight:700; }
  header .goal { color:#aaa; font-size:17px; }
  header .clock { color:#666; font-size:15px; }
  #wrap { width:min(96vw,1400px); }
  svg { width:100%; height:auto; }
  .node rect { stroke-width:2.4px; }
  .node text { font-family:inherit; font-size:17px; font-weight:700; }
  .node .sub { font-size:12.5px; font-weight:400; }
  .pending rect { fill:#1d1d24; stroke:#4a4a55; stroke-dasharray:7 5; }
  .pending text { fill:#666; }
  .done rect { fill:#b2f2bb; stroke:#2f9e44; }
  .done text { fill:#0b2e13; }
  .active text { fill:#101014; }
  .active rect { animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{ filter:drop-shadow(0 0 3px var(--glow,#4dabf7)); }
                     50%{ filter:drop-shadow(0 0 16px var(--glow,#4dabf7)); } }
  .arrow { stroke:#8a8a95; stroke-width:2.2; fill:none; marker-end:url(#arr); }
  .arrow.dim { stroke:#3a3a44; }
  .loop { stroke-width:2; fill:none; stroke-dasharray:8 6; marker-end:url(#arr); opacity:.35; }
  .loop.hot { opacity:1; animation:flow 1s linear infinite; }
  @keyframes flow { to { stroke-dashoffset:-14; } }
  .heat { font-size:19px; font-weight:800; }
  .sat { stroke:#101014; stroke-width:1.4; }
  .sat.run { animation:blink 1s ease-in-out infinite; }
  @keyframes blink { 50%{ opacity:.35; } }
  .wave { fill:#66d9e8; font-size:14px; }
  #idle { color:#555; font-size:18px; margin-top:8px; display:none; }
  .rough { filter:url(#rough); }
  #donebanner { fill:#2f9e44; font-size:30px; font-weight:800; display:none; }
</style></head><body>
<header><span class="mark">&#9068; goal-skill live</span><span class="goal" id="goal"></span><span class="clock" id="clock"></span></header>
<div id="idle">no active goal-skill run &mdash; waiting&hellip;</div>
<div id="wrap"><svg viewBox="0 0 1400 430">
<defs>
  <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#8a8a95"/></marker>
  <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/></filter>
</defs>
<g class="rough" id="scene"></g>
</svg></div>
<script>
const PAL = { blue:['#a5d8ff','#1971c2'], yellow:['#ffec99','#f08c00'], mint:['#96f2d7','#087f5b'] };
const NODES = [
  { id:'plan',       label:'PLAN',      sub:'planner fork',    color:'blue',   x:40   },
  { id:'review',     label:'REVIEW',    sub:'clean judges',    color:'yellow', x:262  },
  { id:'task',       label:'TASK DOC',  sub:'map + registry',  color:'mint',   x:484  },
  { id:'impl',       label:'IMPL',      sub:'wave forks',      color:'blue',   x:706  },
  { id:'codereview', label:'CODE-REV',  sub:'clean',           color:'yellow', x:928  },
  { id:'validate',   label:'VALIDATE',  sub:'evidence',        color:'yellow', x:1150 },
];
const NY=180, NW=170, NH=74;
const svgNS='http://www.w3.org/2000/svg';
const scene=document.getElementById('scene');
function el(t,a){const e=document.createElementNS(svgNS,t);for(const k in a)e.setAttribute(k,a[k]);return e;}

// static skeleton
NODES.forEach((n,i)=>{
  const g=el('g',{class:'node pending',id:'n-'+n.id});
  g.appendChild(el('rect',{x:n.x,y:NY,width:NW,height:NH,rx:14}));
  const t=el('text',{x:n.x+NW/2,y:NY+32,'text-anchor':'middle'}); t.id='t-'+n.id; g.appendChild(t);
  const s=el('text',{x:n.x+NW/2,y:NY+54,'text-anchor':'middle',class:'sub'}); s.id='s-'+n.id; s.textContent=n.sub; g.appendChild(s);
  scene.appendChild(g);
  if(i<NODES.length-1) scene.appendChild(el('path',{class:'arrow dim',id:'a-'+i,
    d:'M'+(n.x+NW+4)+','+(NY+NH/2)+' L'+(NODES[i+1].x-8)+','+(NY+NH/2)}));
});
// loop arcs: review->plan (top), codereview->impl & validate->impl (bottom)
function arc(id,x1,x2,y,cy){ scene.appendChild(el('path',{class:'loop',id,stroke:'#ffd43b',
  d:'M'+x1+','+y+' Q'+((x1+x2)/2)+','+cy+' '+x2+','+y})); }
arc('l-review', NODES[1].x+60, NODES[0].x+110, NY-6, NY-120);
arc('l-codereview', NODES[4].x+60, NODES[3].x+120, NY+NH+6, NY+NH+96);
arc('l-validate', NODES[5].x+60, NODES[3].x+50,  NY+NH+6, NY+NH+150);
// arc → which iter count it visualizes: the review→plan arc glows with PLAN's revision rounds
const heats={review:['l-review','plan',(NODES[0].x+110+NODES[1].x+60)/2,NY-70],
             codereview:['l-codereview','codereview',(NODES[3].x+120+NODES[4].x+60)/2,NY+NH+64],
             validate:['l-validate','validate',(NODES[3].x+50+NODES[5].x+60)/2,NY+NH+118]};
for(const k in heats){const h=el('text',{x:heats[k][2],y:heats[k][3],'text-anchor':'middle',class:'heat'});h.id='h-'+k;scene.appendChild(h);}
const satg=el('g',{id:'sats'}); scene.appendChild(satg);
const doneT=el('text',{x:NODES[5].x+NW/2,y:NY-40,'text-anchor':'middle',id:'donebanner'}); doneT.textContent='\\u2714 DONE'; scene.appendChild(doneT);

const ORDER=NODES.map(n=>n.id);
function heatColor(n){ return n>=4?'#ff6b6b':n===3?'#ffa94d':'#ffd43b'; }

function render(st){
  const idle=document.getElementById('idle');
  if(!st){ idle.style.display='block'; document.getElementById('goal').textContent='';
    document.getElementById('clock').textContent='';
    NODES.forEach(n=>{document.getElementById('n-'+n.id).setAttribute('class','node pending');
      document.getElementById('t-'+n.id).textContent=n.label;});
    doneT.style.display='none'; satg.innerHTML=''; waveT.textContent='';
    for(const k in heats){document.getElementById('h-'+k).textContent='';
      document.getElementById(heats[k][0]).setAttribute('class','loop');}
    return; }
  idle.style.display='none';
  document.getElementById('goal').textContent=st.goal||'';
  const mins=st.started?Math.max(0,Math.round((Date.now()-Date.parse(st.started))/60000)):null;
  document.getElementById('clock').textContent=(mins!=null?mins+' min':'');
  const cur=st.phase==='done'?ORDER.length:Math.max(0,ORDER.indexOf(st.phase));
  NODES.forEach((n,i)=>{
    const g=document.getElementById('n-'+n.id), t=document.getElementById('t-'+n.id);
    const it=(st.iters||{})[n.id]||0;
    if(st.phase==='done'||i<cur){ g.setAttribute('class','node done'); t.textContent='\\u2714 '+n.label; }
    else if(i===cur){ g.setAttribute('class','node active');
      const [f,s]=PAL[n.color]; const r=g.querySelector('rect');
      r.style.fill=f; r.style.stroke=s; g.style.setProperty('--glow',s); t.textContent='\\u25B6 '+n.label; }
    else { g.setAttribute('class','node pending'); const r=g.querySelector('rect');
      r.style.fill=''; r.style.stroke=''; t.textContent=n.label; }
    if(it>1){ const ts=document.createElementNS(svgNS,'tspan');
      ts.textContent=' \\u00D7'+it; ts.style.fill=heatColor(it); t.appendChild(ts); }
    if(i<NODES.length-1) document.getElementById('a-'+i).setAttribute('class','arrow'+(i<cur?'':' dim'));
  });
  for(const k in heats){
    const n=(st.iters||{})[k]||0; const h=document.getElementById('h-'+k); const l=document.getElementById(heats[k][0]);
    if(n>=2){ h.textContent='\\u00D7'+n; h.style.fill=heatColor(n); l.setAttribute('class','loop hot'); l.style.stroke=heatColor(n); }
    else { h.textContent=''; l.setAttribute('class','loop'); l.style.stroke='#ffd43b'; }
  }
  satg.innerHTML='';
  const forks=(st.impl&&st.impl.forks)||[];
  const cx=NODES[3].x+NW/2, cy=NY+NH/2, RX=112, RY=62;
  forks.forEach((f,i)=>{
    const a=-Math.PI/2+i*(2*Math.PI/Math.max(forks.length,1));
    const col=f.s==='done'?'#69db7c':f.s==='run'?'#ffd43b':f.s==='fail'?'#ff6b6b':'#555';
    satg.appendChild(el('circle',{cx:cx+RX*Math.cos(a),cy:cy+RY*Math.sin(a),r:9,fill:col,
      class:'sat'+(f.s==='run'?' run':'')}));
  });
  document.getElementById('s-impl').textContent=(st.impl&&st.impl.waves)
    ?('wave '+(st.impl.wave||1)+' / '+st.impl.waves):'wave forks';
  doneT.style.display=st.phase==='done'?'block':'none';
}
async function tick(){ try{ const r=await fetch('/state',{cache:'no-store'});
    render(r.ok?await r.json():null); }catch(e){ render(null); } }
tick(); setInterval(tick,800);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/state')) {
    try {
      const raw = fs.readFileSync(STATE, 'utf8');
      const st = JSON.parse(raw);
      const upd = Date.parse(st.updated || st.started || 0);
      if (!upd || Date.now() - upd > 3 * 3600 * 1000) throw new Error('stale');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(raw);
    } catch {
      res.writeHead(404); return res.end();
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('port ' + PORT + ' is already in use — a viewer is probably running: http://localhost:' + PORT);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('goal-skill live viewer: ' + url);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) exec('open ' + url);
});
