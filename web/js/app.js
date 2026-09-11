(function(){
"use strict";

/* ---------- CONFIG ---------- */
const DATA_DIR = 'data';
const TRIGGER_THRESHOLD = 0.8; // matches TRIGGER_PROB in the detection pipeline
const SPEED_FPS = {1:6, 10:60, 60:360}; // frames advanced per real second (frame = 10 sim-minutes)
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STATUS_COLOR = {normal:'var(--green)', elevated:'var(--amber)', critical:'var(--red)'};
const STATUS_HEX = {normal:'#1f8a4c', elevated:'#b8790b', critical:'#c9302c'};
const DISASTER_LABEL = {cloudburst_glof:'Cloudburst / GLOF', earthquake:'Earthquake'};

/* ---------- STATE ---------- */
const state = {
  // frameIndex is always an integer — the only thing used for data lookups.
  // frameFloat accumulates fractional progress during animated playback so
  // the scrub playhead can glide smoothly instead of visibly stepping;
  // CB_FRAMES[frameFloat] would silently return undefined for a fractional
  // key, so lookups must never use it directly.
  frameIndex: 0, frameFloat: 0, playing:false, speed:1, selectedStation:null,
  currentView:'monitor', lastTs:null, revealedCases: new Set(),
};

/* ---------- DATA (populated by loadData) ---------- */
let STATIONS = [], STATION_LOOKUP = {}, EPICENTER = null;
let CB_FRAMES = [], EQ_FRAMES = [], CB_STATION_PROB = [], EQ_STATION_PROB = [];
let CB_REGIONAL = [], EQ_REGIONAL = [], CASES = [];
let CB_REGIONAL_DISPLAY = [], EQ_REGIONAL_DISPLAY = [];
let CB_DAMAGE = null, EQ_DAMAGE = null; // {cells:[{id,lat,lon}], frames:[{timestamp,values[]}]}

function rollingMedian(series, window=5){
  const half = Math.floor(window/2);
  return series.map((_, i) => {
    const lo = Math.max(0, i-half), hi = Math.min(series.length-1, i+half);
    const vals = series.slice(lo, hi+1).map(r=>r.probability).sort((a,b)=>a-b);
    return vals[Math.floor(vals.length/2)];
  });
}
let FRAME_ISO = [];
let TOTAL_FRAMES = 0;

/* Timestamps are naive local (Sikkim) ISO strings with no timezone suffix —
   deliberately never parsed through Date(), whose no-timezone-suffix parsing
   is locale-dependent. Fixed-width ISO strings sort/compare lexicographically
   in true chronological order, so plain string ops are used throughout. */
function parseIso(iso){
  const [datePart, timePart] = iso.split('T');
  const [y,mo,d] = datePart.split('-').map(Number);
  const [h,mi] = timePart.split(':').map(Number);
  return {y,mo,d,h,mi};
}
function formatLabel(iso){
  const t = parseIso(iso);
  return `${MONTH_NAMES[t.mo-1]} ${t.d}, ${String(t.h).padStart(2,'0')}:${String(t.mi).padStart(2,'0')}`;
}

async function loadData(){
  const fetchJson = (name) => fetch(`${DATA_DIR}/${name}`).then(r=>{
    if(!r.ok) throw new Error(`Failed to load ${name}: ${r.status}`);
    return r.json();
  });
  const [stationsRes, cbFrames, eqFrames, cbStationProb, eqStationProb, cbRegional, eqRegional, cases, cbDamage, eqDamage] = await Promise.all([
    fetchJson('stations.json'),
    fetchJson('cloudburst_frames.json'),
    fetchJson('earthquake_frames.json'),
    fetchJson('cloudburst_station_probability_frames.json'),
    fetchJson('earthquake_station_probability_frames.json'),
    fetchJson('cloudburst_regional_probability.json'),
    fetchJson('earthquake_regional_probability.json'),
    fetchJson('cases.json'),
    fetchJson('cloudburst_damage_grid.json'),
    fetchJson('earthquake_damage_grid.json'),
  ]);
  STATIONS = stationsRes.stations;
  STATION_LOOKUP = Object.fromEntries(STATIONS.map(s=>[s.id, s]));
  EPICENTER = stationsRes.earthquake_epicenter;
  CB_FRAMES = cbFrames; EQ_FRAMES = eqFrames;
  CB_STATION_PROB = cbStationProb; EQ_STATION_PROB = eqStationProb;
  CB_REGIONAL = cbRegional; EQ_REGIONAL = eqRegional;
  // A rolling median (not the raw curve) drives the live gauge display only —
  // the underlying max-of-7-stations regional probability is, by construction,
  // biased upward by "max of several noisy signals" order statistics and can
  // spike briefly from a single frame's noise. A 5-frame median cancels a
  // lone spike outright while still tracking a genuinely sustained rise
  // almost immediately. The actual trigger/case logic never uses this — it
  // already runs on the raw curve server-side and is unaffected.
  CB_REGIONAL_DISPLAY = rollingMedian(cbRegional);
  EQ_REGIONAL_DISPLAY = rollingMedian(eqRegional);
  CASES = cases;
  CB_DAMAGE = cbDamage; EQ_DAMAGE = eqDamage;
  TOTAL_FRAMES = CB_FRAMES.length;
  FRAME_ISO = CB_FRAMES.map(f=>f.timestamp);
  state.selectedStation = STATIONS[0].id;
}

/* ---------- SENSOR / RISK LOOKUPS ---------- */
function stationSample(stationId, frameIndex){
  const cb = (CB_FRAMES[frameIndex] && CB_FRAMES[frameIndex].stations[stationId]) || {};
  const eq = (EQ_FRAMES[frameIndex] && EQ_FRAMES[frameIndex].stations[stationId]) || {};
  return {
    rainfall: cb.rainfall_mm_hr ?? 0,
    waterLevel: cb.water_level_m, // null for reference stations
    tremor: cb.ground_tremor_index ?? 0,
    seismic: eq.seismic_amplitude ?? 0,
  };
}
function stationRisk(stationId, frameIndex){
  const cbP = (CB_STATION_PROB[frameIndex] && CB_STATION_PROB[frameIndex].stations[stationId]) ?? 0;
  const eqP = (EQ_STATION_PROB[frameIndex] && EQ_STATION_PROB[frameIndex].stations[stationId]) ?? 0;
  return Math.max(cbP ?? 0, eqP ?? 0);
}
function riskStatus(p){
  if(p>=TRIGGER_THRESHOLD) return 'critical';
  if(p>=0.4) return 'elevated';
  return 'normal';
}
function frameIndexAtOrBefore(iso){
  // Frames are coarser (10-min) than a detection's second-level timestamp;
  // find the last frame at or before it. Binary search over sorted ISO strings.
  let lo=0, hi=FRAME_ISO.length-1, ans=0;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    if(FRAME_ISO[mid] <= iso){ ans=mid; lo=mid+1; } else hi=mid-1;
  }
  return ans;
}

/* ---------- DAMAGE HEAT MAP COLOR ---------- */
// 0-10 severity: light red (low) to heavy/deep red (high) — linear RGB lerp.
const DAMAGE_LOW_RGB = [253, 232, 232];
const DAMAGE_HIGH_RGB = [122, 10, 10];
function damageColor(value){
  const t = Math.max(0, Math.min(1, value/10));
  const rgb = DAMAGE_LOW_RGB.map((lo,i)=> Math.round(lo + (DAMAGE_HIGH_RGB[i]-lo)*t));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/* ---------- LEAFLET MAP ---------- */
let leafMap, markerRefs = {}, epicenterMarker = null, riverLine = null;
let damageRects = [], damageLayerVisible = true;

function buildMap(){
  const lats = STATIONS.map(s=>s.lat), lons = STATIONS.map(s=>s.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);

  leafMap = L.map('mapDiv', {zoomControl:true, attributionControl:true, scrollWheelZoom:true});
  leafMap.fitBounds([[latMin-0.06, lonMin-0.06],[latMax+0.06, lonMax+0.06]]);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'&copy; OpenStreetMap contributors', maxZoom:14}).addTo(leafMap);

  // Damage heat map cells — added before station markers so they paint underneath.
  const damageCells = (CB_DAMAGE && CB_DAMAGE.cells) || [];
  damageRects = damageCells.map(cell => L.rectangle(
    [[cell.latMin, cell.lonMin],[cell.latMax, cell.lonMax]],
    {stroke:false, fillColor:damageColor(0), fillOpacity:0.55, interactive:false, className:'damage-cell'}
  ).addTo(leafMap));

  const corridor = STATIONS.filter(s=>s.has_water_level).sort((a,b)=>a.basin_km-b.basin_km);
  riverLine = L.polyline(corridor.map(s=>[s.lat,s.lon]), {color:'#2b7fb0', weight:3, opacity:0.7})
    .addTo(leafMap).bindTooltip('Teesta Basin corridor', {permanent:false});

  STATIONS.forEach(s=>{
    const dot = L.circleMarker([s.lat,s.lon], {radius:8, color:'#ffffff', weight:2, fillColor:'#1f8a4c', fillOpacity:1}).addTo(leafMap);
    const pulse = L.circleMarker([s.lat,s.lon], {radius:0, color:'#c9302c', weight:1.5, fill:false, opacity:0}).addTo(leafMap);
    dot.bindTooltip(s.name, {direction:'top', offset:[0,-8]});
    dot.on('click', ()=>{ state.selectedStation = s.id; renderStationList(); renderStationDetail(); });
    markerRefs[s.id] = {dot,pulse};
  });

  if(EPICENTER){
    epicenterMarker = L.circleMarker([EPICENTER.lat, EPICENTER.lon], {
      radius:10, color:'#c9302c', weight:2, fill:true, fillColor:'#c9302c', fillOpacity:0.15, dashArray:'3,3',
    }).bindTooltip('Estimated epicenter', {permanent:false});
  }
}

/* ---------- GAUGES ---------- */
function buildGauge(container, label){
  const wrap = document.createElement('div'); wrap.className='gauge-card';
  const size=76, r=30, c=2*Math.PI*r;
  wrap.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="8"/>
      <circle class="ring" cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="8"
        stroke-dasharray="${c}" stroke-dashoffset="${c}" stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})"/>
    </svg>
    <div class="gauge-info">
      <div class="g-label">${label}</div>
      <div class="g-val">0%</div>
      <div class="g-sub">threshold ${Math.round(TRIGGER_THRESHOLD*100)}%</div>
    </div>`;
  container.appendChild(wrap);
  return {ring: wrap.querySelector('.ring'), val: wrap.querySelector('.g-val'), c};
}
let gaugeFlood, gaugeQuake;
function setGauge(g, pct, danger){
  const offset = g.c*(1-pct);
  g.ring.setAttribute('stroke-dashoffset', offset);
  g.ring.setAttribute('stroke', danger ? 'var(--red)' : 'var(--accent)');
  g.val.textContent = Math.round(pct*100)+'%';
  g.val.style.color = danger ? 'var(--red)' : 'var(--text)';
}

/* ---------- SPARKLINE ---------- */
function sparkline(values, w, h){
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max-min)||1;
  const pts = values.map((v,i)=> [ (i/Math.max(1,values.length-1))*w, h - ((v-min)/span)*h*0.85 - h*0.075 ]);
  return pts.map((p,i)=> (i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
}
function sparkSvg(values,color,vb){
  const w=280,h=34;
  const d = sparkline(values,w,h);
  return `<svg viewBox="0 0 ${w} ${h}"${vb?` style="${vb}"`:''}><path d="${d}" fill="none" stroke="${color}" stroke-width="1.75"/></svg>`;
}

/* ---------- STATION LIST / DETAIL ---------- */
function renderStationList(){
  const el = document.getElementById('stationList');
  el.innerHTML='';
  STATIONS.forEach(s=>{
    const sample = stationSample(s.id, state.frameIndex);
    const status = riskStatus(stationRisk(s.id, state.frameIndex));
    const row = document.createElement('div');
    row.className='station-row'+(s.id===state.selectedStation?' selected':'');
    row.innerHTML = `<span class="status-dot" style="background:${STATUS_COLOR[status]}"></span><span class="name">${s.name}</span><span class="val">${sample.rainfall.toFixed(1)}mm/hr</span>`;
    row.addEventListener('click', ()=>{ state.selectedStation=s.id; renderStationList(); renderStationDetail(); });
    el.appendChild(row);
  });
}
function renderStationDetail(){
  const s = STATION_LOOKUP[state.selectedStation];
  const el = document.getElementById('stationDetail');
  const N=24; // last 24 frames = 4 hours
  const rain=[], water=[], tremor=[], seismic=[];
  for(let i=N-1;i>=0;i--){
    const idx = Math.max(0, state.frameIndex-i);
    const smp = stationSample(s.id, idx);
    rain.push(smp.rainfall); tremor.push(smp.tremor); seismic.push(smp.seismic);
    if(s.has_water_level) water.push(smp.waterLevel ?? 0);
  }
  const cur = stationSample(s.id, state.frameIndex);
  const status = riskStatus(stationRisk(s.id, state.frameIndex));
  const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;

  let waterBlock = '';
  if(s.has_water_level){
    waterBlock = `<div class="metric-block"><div class="metric-label"><span>Water Level</span><span class="metric-val">${cur.waterLevel.toFixed(2)} m <span style="color:var(--text-faint);font-weight:400">avg ${avg(water).toFixed(2)}</span></span></div>${sparkSvg(water,'#2b7fb0')}</div>`;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
      <span class="status-dot" style="background:${STATUS_COLOR[status]}"></span>
      <strong style="font-size:13.5px">${s.name}</strong>
      <span style="margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--text-faint);text-transform:uppercase">${status}</span>
    </div>
    <div class="metric-block"><div class="metric-label"><span>Rainfall</span><span class="metric-val">${cur.rainfall.toFixed(1)} mm/hr <span style="color:var(--text-faint);font-weight:400">avg ${avg(rain).toFixed(1)}</span></span></div>${sparkSvg(rain, STATUS_HEX[status])}</div>
    ${waterBlock}
    <div class="metric-block"><div class="metric-label"><span>Ground Tremor</span><span class="metric-val">${cur.tremor.toFixed(2)} idx <span style="color:var(--text-faint);font-weight:400">avg ${avg(tremor).toFixed(2)}</span></span></div>${sparkSvg(tremor,'#7a4fae')}</div>
    <div class="metric-block"><div class="metric-label"><span>Seismic Amplitude</span><span class="metric-val">${cur.seismic.toFixed(3)} <span style="color:var(--text-faint);font-weight:400">avg ${avg(seismic).toFixed(3)}</span></span></div>${sparkSvg(seismic,'#c9302c')}</div>
  `;
}

/* ---------- TRANSPORT / TIMELINE ---------- */
let scrubTrack, scrubFill, scrubPlayhead, timeLabelEl, playBtn;

function setFrame(idx){
  const clamped = Math.max(0, Math.min(TOTAL_FRAMES-1, Math.round(idx)));
  state.frameFloat = clamped;
  state.frameIndex = clamped;
  render();
}
function initTransport(){
  scrubTrack = document.getElementById('scrubTrack');
  scrubFill = document.getElementById('scrubFill');
  scrubPlayhead = document.getElementById('scrubPlayhead');
  timeLabelEl = document.getElementById('timeLabel');
  playBtn = document.getElementById('playBtn');

  scrubTrack.addEventListener('pointerdown', e=>{
    state.playing=false; playBtn.textContent='▶';
    const move = (ev)=>{
      const rect = scrubTrack.getBoundingClientRect();
      const frac = Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width));
      setFrame(frac*(TOTAL_FRAMES-1));
    };
    move(e);
    const up=()=>{ window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); };
    window.addEventListener('pointermove',move);
    window.addEventListener('pointerup',up);
  });
  document.getElementById('speedSelect').addEventListener('click', e=>{
    const btn = e.target.closest('button'); if(!btn) return;
    state.speed = Number(btn.dataset.speed);
    document.querySelectorAll('#speedSelect button').forEach(b=>b.classList.toggle('active', b===btn));
  });
  playBtn.addEventListener('click', ()=>{
    state.playing = !state.playing;
    playBtn.textContent = state.playing ? '❚❚' : '▶';
    state.lastTs = null;
  });
}

/* ---------- TRIGGER / ALERT / CASE REVEAL ---------- */
function addScrubMarker(fraction){
  const marker = document.createElement('div');
  marker.className = 'scrub-marker';
  marker.style.left = (fraction*100)+'%';
  document.getElementById('scrubMarkers').appendChild(marker);
}
function revealCase(caseObj){
  state.revealedCases.add(caseObj.case_id);
  const badge = document.getElementById('casesBadge');
  badge.style.display = 'inline-block';
  badge.textContent = String(state.revealedCases.size);

  document.getElementById('alertBanner').classList.add('show');
  document.getElementById('alertText').textContent =
    `${DISASTER_LABEL[caseObj.disaster_type] || caseObj.disaster_type} threshold exceeded — ${caseObj.location.region_label}. Case ${caseObj.case_id} created.`;
  document.getElementById('alertLink').onclick = (e)=>{ e.preventDefault(); openCaseDetail(caseObj.case_id); };
  showToast('Case created', caseObj.title);

  const frameIdx = frameIndexAtOrBefore(caseObj.detected_at);
  addScrubMarker(frameIdx/(TOTAL_FRAMES-1));
  renderCasesView();
}
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('alertDismiss').addEventListener('click', ()=> document.getElementById('alertBanner').classList.remove('show'));
});
function showToast(title, sub){
  const t = document.createElement('div'); t.className='toast';
  t.innerHTML = `<strong>${title}</strong><span>${sub}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 5000);
}

/* ---------- RENDER LOOP ---------- */
function render(){
  const currentIso = FRAME_ISO[state.frameIndex];

  STATIONS.forEach(s=>{
    const status = riskStatus(stationRisk(s.id, state.frameIndex));
    const ref = markerRefs[s.id];
    ref.dot.setStyle({fillColor: STATUS_HEX[status]});
    if(status==='critical'){
      ref.pulse.setStyle({radius:14, color:STATUS_HEX[status], opacity:(0.6+0.4*Math.sin(performance.now()/180))});
    } else {
      ref.pulse.setStyle({radius:0, opacity:0});
    }
  });
  renderStationList();
  renderStationDetail();

  if(damageLayerVisible && CB_DAMAGE && EQ_DAMAGE){
    const cbValues = CB_DAMAGE.frames[state.frameIndex].values;
    const eqValues = EQ_DAMAGE.frames[state.frameIndex].values;
    damageRects.forEach((rect, i)=>{
      const v = Math.max(cbValues[i], eqValues[i]);
      rect.setStyle({fillColor: damageColor(v), fillOpacity: v < 0.3 ? 0.12 : 0.55});
    });
  }

  const cbProb = CB_REGIONAL_DISPLAY[state.frameIndex] || 0;
  const eqProb = EQ_REGIONAL_DISPLAY[state.frameIndex] || 0;
  setGauge(gaugeFlood, cbProb, cbProb>=TRIGGER_THRESHOLD);
  setGauge(gaugeQuake, eqProb, eqProb>=TRIGGER_THRESHOLD);

  const frac = state.frameFloat/(TOTAL_FRAMES-1)*100; // continuous, for a smooth-gliding playhead
  scrubFill.style.width = frac+'%';
  scrubPlayhead.style.left = frac+'%';
  timeLabelEl.textContent = formatLabel(currentIso);
  document.getElementById('clock').textContent = 'SIM T+ '+formatLabel(currentIso);

  CASES.forEach(c=>{
    if(!state.revealedCases.has(c.case_id) && currentIso >= c.detected_at){
      revealCase(c);
      if(c.disaster_type==='earthquake' && epicenterMarker) epicenterMarker.addTo(leafMap);
    }
  });
}

function tick(ts){
  if(state.lastTs===null) state.lastTs = ts;
  const dt = (ts - state.lastTs)/1000;
  state.lastTs = ts;
  if(state.playing){
    state.frameFloat += SPEED_FPS[state.speed]*dt;
    if(state.frameFloat>=TOTAL_FRAMES-1){ state.frameFloat=TOTAL_FRAMES-1; state.playing=false; playBtn.textContent='▶'; }
    state.frameIndex = Math.floor(state.frameFloat);
    render();
  }
  requestAnimationFrame(tick);
}

/* ---------- NAV / VIEWS ---------- */
function switchView(view){
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.toggle('active', t.dataset.view===view));
  document.getElementById('view-'+view).classList.add('active');
}

/* ---------- CASES VIEW ---------- */
const SEV_COLORS = {
  critical: {bg:'oklch(92% 0.05 25)', fg:'oklch(38% 0.18 25)'},
  high: {bg:'oklch(93% 0.05 70)', fg:'oklch(38% 0.14 70)'},
  moderate: {bg:'oklch(93% 0.04 220)', fg:'oklch(38% 0.1 220)'},
};
function phaseSegClass(status){
  if(status==='complete') return 'done';
  if(status==='active') return 'active';
  return '';
}
function renderCasesView(){
  const content = document.getElementById('casesContent');
  const visibleCases = CASES.filter(c=>state.revealedCases.has(c.case_id));
  document.getElementById('casesSub').textContent = `${visibleCases.length} active`;
  if(visibleCases.length===0){
    content.innerHTML = `<div class="empty-state"><div class="big">◎</div>No active cases — monitoring nominal.<br>Cases appear automatically when a disaster probability crosses threshold on the Monitor.</div>`;
    return;
  }
  content.innerHTML = `
    <table class="cases-table">
      <thead><tr><th></th><th>Case</th><th>Region</th><th>Detected</th><th>Severity</th><th>Phase</th></tr></thead>
      <tbody>
        ${visibleCases.map(c=>{
          const sev = SEV_COLORS[c.severity.severity_label] || SEV_COLORS.moderate;
          return `<tr class="case-row" data-case="${c.case_id}">
            <td><div class="type-icon"><span class="shape"></span></div></td>
            <td>${c.title}</td>
            <td>${c.location.region_label}</td>
            <td style="font-family:var(--mono);color:var(--text-dim)">${formatLabel(c.detected_at)}</td>
            <td><span class="sev-badge" style="background:${sev.bg};color:${sev.fg}">${Math.round(c.severity.peak_probability*100)} — ${c.severity.severity_label.toUpperCase()}</span></td>
            <td><div class="phase-mini"><span class="seg ${phaseSegClass(c.phase_1.status)}"></span><span class="seg ${phaseSegClass(c.phase_2.status)}"></span><span class="seg ${phaseSegClass(c.phase_3.status)}"></span></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  content.querySelectorAll('.case-row').forEach(row=>{
    row.addEventListener('click', ()=> openCaseDetail(row.dataset.case));
  });
}

/* ---------- CASE DETAIL VIEW ---------- */
function stepClass(status){
  if(status==='complete') return 'done';
  if(status==='active') return 'active';
  return 'pending';
}
function stepCircle(status){
  return status==='complete' ? '✓' : null;
}
function openCaseDetail(caseId){
  const c = CASES.find(x=>x.case_id===caseId); if(!c) return;
  document.getElementById('detailTitle').textContent = c.title;
  document.getElementById('detailDetected').textContent = 'Detected '+formatLabel(c.detected_at);
  document.getElementById('detailType').textContent = DISASTER_LABEL[c.disaster_type] || c.disaster_type;
  document.getElementById('detailSeverity').textContent = `Severity ${c.severity.severity_label} (peak ${Math.round(c.severity.peak_probability*100)}%)`;

  const phases = [
    {n:1, label:'Detection & Surveillance', status:c.phase_1.status},
    {n:2, label:'Search & Connectivity', status:c.phase_2.status},
    {n:3, label:'Relief Delivery', status:c.phase_3.status},
  ];
  document.getElementById('stepper').innerHTML = phases.map((p,i)=>{
    const cls = stepClass(p.status);
    const circle = stepCircle(p.status) || p.n;
    const line = i<phases.length-1 ? `<div class="line" style="${cls==='done'?'background:var(--green)':''}"></div>` : '';
    return `<div class="step ${cls}"><div class="circle">${circle}</div><div class="label">${p.n} · ${p.label}</div></div>${line}`;
  }).join('');

  renderPhase1Tab(c);
  document.getElementById('tab-p2').innerHTML = `
    <div class="placeholder-shell">
      <div class="tag">Phase 2 · Status: ${c.phase_2.status}</div>
      Search progress, relay-node placement on the map, and connectivity-restored % will render here once Phase 2 simulation is implemented.
    </div>`;
  document.getElementById('tab-p3').innerHTML = `
    <div class="placeholder-shell">
      <div class="tag">Phase 3 · Status: ${c.phase_3.status}</div>
      Dispatch status, sorties completed, and supplies delivered vs. pending will render here once Phase 3 simulation is implemented.
    </div>`;

  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab==='p1'));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-p1').classList.add('active');
  switchView('detail');
}

function renderPhase1Tab(c){
  const regional = c.disaster_type==='earthquake' ? EQ_REGIONAL : CB_REGIONAL;
  const detectIdx = frameIndexAtOrBefore(c.detected_at);
  const N=30, half=15;
  const lo = Math.max(0, detectIdx-half), hi = Math.min(regional.length-1, detectIdx+half);
  const probSeries = regional.slice(lo, hi+1).map(r=>r.probability);

  const contributing = c.disaster_type==='cloudburst_glof'
    ? (c.severity.corridor_stations || [])
    : (c.severity.contributing_stations || []);
  const affected = contributing.map(id=>STATION_LOOKUP[id]).filter(Boolean);

  const firedRows = affected.map(s=>{
    const smp = stationSample(s.id, detectIdx);
    const detail = c.disaster_type==='earthquake'
      ? `${smp.seismic.toFixed(3)} amplitude`
      : `${smp.rainfall.toFixed(1)} mm/hr · ${s.has_water_level ? smp.waterLevel.toFixed(2)+' m' : '—'}`;
    return `<div class="fired-row"><span class="n">${s.name}</span><span class="v">${detail}</span></div>`;
  }).join('');

  const modelParams = Object.entries(c.phase_1.model_params || {})
    .filter(([k,v])=> typeof v !== 'object')
    .map(([k,v])=>`<code>${k}=${v}</code>`).join(' ');

  const damageCardHtml = damageGridCardHtml(c.phase_1.damage_grid);

  document.getElementById('tab-p1').innerHTML = `
    <div class="dgrid">
      <div class="card">
        <h3>${DISASTER_LABEL[c.disaster_type]||c.disaster_type} Probability — Trigger Window</h3>
        ${sparkSvg(probSeries.length?probSeries:[0,0], '#e1594f', 'height:120px')}
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--text-faint);margin-top:6px">
          <span>${formatLabel(FRAME_ISO[lo])}</span><span>Crossed threshold (${Math.round(TRIGGER_THRESHOLD*100)}%) → ${formatLabel(c.detected_at)}</span>
        </div>
        <div class="model-note">${c.phase_1.summary}<br>Model: <code>${c.phase_1.model}</code> ${modelParams}</div>
      </div>
      <div class="card">
        <h3>Fired Sensors</h3>
        <div class="fired-list">${firedRows || '<span style="color:var(--text-faint);font-size:12px">No individual station crossed its own threshold.</span>'}</div>
      </div>
      <div class="card" style="grid-column:1/-1">
        <h3>Affected Zone</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${affected.map(s=>`<span class="meta-chip">${s.name}</span>`).join('') || '<span class="meta-chip">—</span>'}
          ${c.location.region_label ? `<span class="meta-chip">${c.location.region_label}</span>` : ''}
        </div>
      </div>
      ${damageCardHtml}
    </div>`;
}

/* Static damage-severity heat map snapshot (CV-simulated infrastructure
   assessment) at the moment of detection — a small colored grid, not a live map. */
function damageGridCardHtml(damageGrid){
  if(!damageGrid || !damageGrid.cells || !damageGrid.values) return '';
  const cells = damageGrid.cells, values = damageGrid.values;
  let cols = cells.length;
  for(let i=1;i<cells.length;i++) if(cells[i].lon < cells[i-1].lon){ cols = i; break; }
  const swatches = values.map(v=>
    `<div title="${v.toFixed(1)}" style="background:${damageColor(v)};aspect-ratio:1;border-radius:2px"></div>`
  ).join('');
  return `
    <div class="card" style="grid-column:1/-1">
      <h3>Damage / Infrastructure Assessment (simulated CV pass)</h3>
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:2px;max-width:420px">${swatches}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px;color:var(--text-dim)">
        <span>0</span><div class="damage-scale-bar" style="flex:none"></div><span>10</span>
        <span style="margin-left:10px">Severity index at time of detection — distance-weighted from raw sensor intensity, independent of the detection probability above.</span>
      </div>
    </div>`;
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.nav-tab').forEach(tab=>{
    tab.addEventListener('click', ()=> switchView(tab.dataset.view));
  });
  document.getElementById('backToCases').addEventListener('click', ()=> switchView('cases'));
  document.getElementById('damageToggle').addEventListener('change', (e)=>{
    damageLayerVisible = e.target.checked;
    damageRects.forEach(rect => { rect.getElement() && (rect.getElement().style.display = damageLayerVisible ? '' : 'none'); });
  });
  document.getElementById('tabbar').addEventListener('click', e=>{
    const tab = e.target.closest('.tab'); if(!tab) return;
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t===tab));
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
  });
});

/* ---------- INIT ---------- */
async function init(){
  const loadingOverlay = document.getElementById('loadingOverlay');
  const errorOverlay = document.getElementById('errorOverlay');
  errorOverlay.hidden = true;
  loadingOverlay.hidden = false;
  try {
    await loadData();
    buildMap();
    const probPanel = document.getElementById('probPanel');
    gaugeFlood = buildGauge(probPanel, 'Cloudburst / Flood Risk');
    gaugeQuake = buildGauge(probPanel, 'Seismic Risk');
    initTransport();
    renderCasesView();
    render();
    requestAnimationFrame(tick);
    loadingOverlay.hidden = true;
  } catch (err) {
    console.error('Failed to initialize:', err);
    loadingOverlay.hidden = true;
    document.getElementById('errorDetail').textContent = err.message || String(err);
    errorOverlay.hidden = false;
  }
}
document.getElementById('retryBtn')?.addEventListener('click', () => location.reload());

document.addEventListener('DOMContentLoaded', init);
})();
