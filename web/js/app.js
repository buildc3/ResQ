(function(){
"use strict";

/* ---------- CONFIG ---------- */
const DATA_DIR = 'data';
const TRIGGER_THRESHOLD = 0.8; // matches TRIGGER_PROB in the detection pipeline
const BASE_FPS_PER_X = 6; // frames advanced per real second at 1x (frame = 10 sim-minutes) — fps = speed * BASE_FPS_PER_X
const MIN_SPEED = 0.05, MAX_SPEED = 2000;
// Slider is a 0-100 log scale over MIN_SPEED..MAX_SPEED so one control usefully
// covers everything from slow-motion to "finish in under a second".
function sliderToSpeed(v){
  const t = v/100;
  return Math.pow(10, Math.log10(MIN_SPEED) + t*(Math.log10(MAX_SPEED)-Math.log10(MIN_SPEED)));
}
function speedToSlider(speed){
  const t = (Math.log10(speed)-Math.log10(MIN_SPEED))/(Math.log10(MAX_SPEED)-Math.log10(MIN_SPEED));
  return Math.max(0, Math.min(100, t*100));
}
function clampSpeed(v){ return Math.max(MIN_SPEED, Math.min(MAX_SPEED, v)); }
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STATUS_COLOR = {normal:'var(--green)', elevated:'var(--amber)', critical:'var(--red)'};
const STATUS_HEX = {normal:'#1f8a4c', elevated:'#b8790b', critical:'#c9302c'};
const DISASTER_LABEL = {cloudburst_glof:'Cloudburst / GLOF', earthquake:'Earthquake'};
const PREFERS_REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- PLAIN-LANGUAGE TOOLTIPS FOR MODEL JARGON ---------- */
const MODEL_TOOLTIPS = {
  rolling_zscore_fusion: "Detects anomalies by comparing each station's live rainfall, water-level, and tremor readings to its own recent normal range, then combines all three into one score.",
  sta_lta_multistation: "The standard seismology trigger: compares a short recent average of ground motion to a longer baseline average — a sudden spike signals an earthquake. Confirmed only once multiple stations agree.",
  baseline_window_samples: "How many past readings define \"normal\" for comparison (144 samples = 24 hours at 10-min resolution).",
  min_periods: "Minimum history required before the model trusts its own baseline enough to score anomalies.",
  sigmoid_k: "How sharply probability ramps up once past the anomaly threshold — higher = a more decisive on/off switch, lower = a more gradual rise.",
  trigger_probability: "The probability that must be reached and sustained before a case is created.",
  confirm_samples: "How many consecutive anomalous readings are required before triggering — stops a single noisy blip from creating a false alarm.",
  weights_with_water_level: "How much each signal (rainfall, water-level rise, tremor) counts toward the combined score at river/lake stations.",
  weights_without_water_level: "Same idea, for reference stations with no water-level sensor.",
  sta_samples: "The \"short-term\" window (seconds) — recent ground-motion energy.",
  lta_samples: "The \"long-term\" window (seconds) — baseline ground-motion energy the short-term window is compared against.",
  min_confirming_stations: "Number of stations that must independently trigger within the confirm window before the earthquake is treated as real, not noise.",
  adapt_sigma_multiplier: "Each station's own trigger threshold is calibrated from its own quiet-period noise, not one fixed number for every station — this sets how many standard deviations above normal counts as anomalous.",
  calibration_window_samples: "How many early readings are used to learn this station's own normal noise level before any real event affects the data.",
  calibration_window_seconds: "How many seconds of early data are used to learn this station's own normal noise level before any real event affects the data.",
  min_sigmoid_midpoint: "A floor on the calibrated anomaly threshold — stops an unrealistically quiet calibration window from making a station overreact to normal noise.",
  min_trigger_ratio: "A floor on the calibrated trigger ratio — stops an unrealistically quiet calibration window from making a station overreact to normal noise.",
  adaptive_sigmoid_midpoint_by_station: "Each station's own calibrated anomaly threshold, learned from its own quiet-period data rather than shared across all stations.",
  adaptive_trigger_ratio_by_station: "Each station's own calibrated short-term/long-term energy ratio threshold, learned from its own quiet-period data rather than shared across all stations.",
  confirm_window_seconds: "How close together in time station triggers must land to count as the same event (matches real wave-propagation delay).",
};
function tooltipChip(text, key){
  const tip = MODEL_TOOLTIPS[key];
  if(!tip) return `<code>${text}</code>`;
  return `<code class="info-chip" tabindex="0">${text}<span class="info-tooltip">${tip}</span></code>`;
}

/* ---------- STATE ---------- */
const state = {
  // frameIndex is always an integer — the only thing used for data lookups.
  // frameFloat accumulates fractional progress during animated playback so
  // the scrub playhead can glide smoothly instead of visibly stepping;
  // CB_FRAMES[frameFloat] would silently return undefined for a fractional
  // key, so lookups must never use it directly.
  frameIndex: 0, frameFloat: 0, playing:false, speed:1, selectedStation:null,
  currentView:'monitor', lastTs:null, revealedCases: new Set(),
  openCaseId: null, activeDetailTab: 'p1',
  storyMode:false, storyEvents: [], storyNextIdx: 0,
};

/* ---------- DATA (populated by loadData) ---------- */
let STATIONS = [], STATION_LOOKUP = {}, EPICENTER = null;
let CB_FRAMES = [], EQ_FRAMES = [], CB_STATION_PROB = [], EQ_STATION_PROB = [];
let CB_REGIONAL = [], EQ_REGIONAL = [], CASES = [];
let CB_REGIONAL_DISPLAY = [], EQ_REGIONAL_DISPLAY = [];
let CB_DAMAGE = [], EQ_DAMAGE = []; // [{timestamp, stations:{id:0-10}}, ...] per-station "tower reading" severity

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
/* Duration-only arithmetic (never absolute display) — Date.UTC is used purely
   as an arbitrary consistent integer axis to diff two naive timestamps,
   exactly like the pipeline's own internal date math. */
function minutesBetween(isoA, isoB){
  const a = parseIso(isoA), b = parseIso(isoB);
  const msA = Date.UTC(a.y, a.mo-1, a.d, a.h, a.mi);
  const msB = Date.UTC(b.y, b.mo-1, b.d, b.h, b.mi);
  return Math.round((msB-msA)/60000);
}
function formatDuration(minutes){
  if(minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes/60), m = minutes%60;
  return m===0 ? `${h}h` : `${h}h ${m}m`;
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
    fetchJson('cloudburst_damage_stations.json'),
    fetchJson('earthquake_damage_stations.json'),
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
/** 0-10 simulated damage/infrastructure severity at this tower — the max of both scenarios' readings. */
function stationDamage(stationId, frameIndex){
  const cbD = (CB_DAMAGE[frameIndex] && CB_DAMAGE[frameIndex].stations[stationId]) ?? 0;
  const eqD = (EQ_DAMAGE[frameIndex] && EQ_DAMAGE[frameIndex].stations[stationId]) ?? 0;
  return Math.max(cbD, eqD);
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

/* ---------- PHASE 2: SEARCH & CONNECTIVITY (derived live from the timeline) ----------
   Phase 2 has no separate detection model — its status/progress is entirely a
   function of comparing the current playhead timestamp against the real
   relay-deployment and search schedules baked into the case at pipeline time.
   Same pattern as Phase 1's case-reveal: trust real timestamps, derive UI
   state from wherever the timeline cursor currently sits. */
function computePhase2(c, currentIso){
  const relays = c.phase_2.relay_schedule || [];
  const zones = c.phase_2.search_zones || [];
  const deployedRelays = relays.filter(r => currentIso >= r.deploy_at);
  const pendingRelays = relays.filter(r => currentIso < r.deploy_at);
  const connectivityPct = relays.length ? Math.round((deployedRelays.length/relays.length)*100) : 0;

  let survivorsFound = 0, totalSurvivors = 0;
  const zoneStatuses = zones.map(z=>{
    const foundSoFar = z.survivors.filter(s => currentIso >= s.found_at);
    survivorsFound += foundSoFar.length;
    totalSurvivors += z.survivors.length;
    let status = 'pending';
    if(currentIso >= z.search_complete) status = 'complete';
    else if(currentIso >= z.search_start) status = 'active';
    return {station_id:z.station_id, status, found:foundSoFar.length, total:z.survivors.length, search_start:z.search_start, search_complete:z.search_complete};
  });

  const allSearchDone = zones.length===0 || zones.every(z => currentIso >= z.search_complete);
  const allRelaysDone = relays.length===0 || currentIso >= c.phase_2.connectivity_complete_at;
  const anyStarted = deployedRelays.length>0 || zoneStatuses.some(z=>z.status!=='pending');

  let status = 'pending';
  if(allSearchDone && allRelaysDone) status = 'complete';
  else if(anyStarted) status = 'active';

  return {status, connectivityPct, deployedRelays, pendingRelays, survivorsFound, totalSurvivors, zoneStatuses};
}
function isSearchActiveAt(stationId, currentIso){
  return CASES.some(c => (c.phase_2.search_zones||[]).some(z =>
    z.station_id===stationId && currentIso>=z.search_start && currentIso<z.search_complete));
}

/* ---------- PHASE 3: MEDICAL & RELIEF DELIVERY (derived live from the timeline) ----------
   Same architecture as Phase 2 — no detection model of its own, all live
   state comes from comparing the current playhead against the real
   dispatch/delivery schedule. Medical drones do one precision drop per zone;
   Heavy Payload drones then run repeat resupply sorties for sustained,
   multi-day aid, so "complete" here means every sortie *scheduled within
   this simulation window* has landed — real relief would keep going past it. */
function computePhase3(c, currentIso){
  const meds = c.phase_3.medical_deliveries || [];
  const sorties = c.phase_3.relief_sorties || [];

  const medDelivered = meds.filter(m => currentIso >= m.delivered_at);
  const medKg = medDelivered.reduce((sum,m)=>sum+m.payload_kg, 0);
  const medAnyDispatched = meds.some(m => currentIso >= m.dispatched_at);

  const sortiesDelivered = sorties.filter(s => currentIso >= s.delivered_at);
  const sortiesKg = sortiesDelivered.reduce((sum,s)=>sum+s.payload_kg, 0);

  const allMedDone = meds.length===0 || meds.every(m => currentIso >= m.delivered_at);
  const allSortiesDone = sorties.length===0 || sorties.every(s => currentIso >= s.delivered_at);
  let status = 'pending';
  if(allMedDone && allSortiesDone) status = 'complete';
  else if(medAnyDispatched || sortiesDelivered.length>0) status = 'active';

  return {status, meds, medDelivered, medKg, sorties, sortiesDelivered, sortiesKg, totalKg: medKg+sortiesKg};
}

/* ---------- DAMAGE HEAT MAP COLOR ---------- */
// Classic full-spectrum heat map ramp: green (low) -> yellow -> orange -> red (high),
// matching standard heat-map convention (e.g. weather/density maps) rather than a
// single-hue light-to-dark ramp.
const SEVERITY_STOPS = [
  { t: 0.00, rgb: [46, 168, 90] },   // green
  { t: 0.35, rgb: [190, 210, 60] },  // yellow-green
  { t: 0.55, rgb: [250, 210, 40] },  // yellow
  { t: 0.75, rgb: [250, 140, 30] },  // orange
  { t: 1.00, rgb: [220, 30, 30] },   // red
];
function severityRgb(t){
  t = Math.max(0, Math.min(1, t));
  for(let i=0;i<SEVERITY_STOPS.length-1;i++){
    const a = SEVERITY_STOPS[i], b = SEVERITY_STOPS[i+1];
    if(t>=a.t && t<=b.t){
      const localT = (t-a.t)/(b.t-a.t || 1);
      return a.rgb.map((v,ch)=> Math.round(v + (b.rgb[ch]-v)*localT));
    }
  }
  return SEVERITY_STOPS[SEVERITY_STOPS.length-1].rgb;
}
function damageColor(value){
  const [r,g,b] = severityRgb(value/10);
  return `rgb(${r},${g},${b})`;
}

/* ---------- DAMAGE HEAT MAP (custom canvas layer) ----------
   A small hand-rolled heat renderer instead of a third-party plugin: two
   third-party heat-map libraries in a row produced hidden-internals artifacts
   here (leaflet.heat's undocumented zoom-dependent intensity normalization,
   then visible hard-edged seams from its low-zoom cell-bucketing
   optimization for large radii). Full control over both the accumulation
   and the color mapping avoids both classes of bug outright:
     1. Draw each station as a true canvas radial gradient (opaque center to
        fully transparent at RADIUS_PX) onto an offscreen grayscale-alpha
        canvas, composited with 'lighter' (additive) so overlapping stations'
        influence sums smoothly — no grid bucketing, so no seams.
     2. Read that accumulated alpha back and colorize each pixel through the
        same green->yellow->orange->red ramp used for the legend, writing
        the result to the visible canvas. */
function createHeatCanvas(map){
  const canvas = L.DomUtil.create('canvas', 'damage-heat-canvas');
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', {willReadFrequently:true});
  map.getPanes().overlayPane.appendChild(canvas);

  const RADIUS_PX = 200;
  const CENTER_ALPHA_AT = 6; // station value that reaches full center opacity (0-10 scale)
  let points = []; // [{lat,lon,value}]
  let visible = true;

  function resize(){
    const size = map.getSize();
    canvas.width = off.width = size.x;
    canvas.height = off.height = size.y;
    const topLeft = map.containerPointToLayerPoint([0,0]);
    L.DomUtil.setPosition(canvas, topLeft);
  }

  function redraw(){
    if(!visible) return;
    resize();
    const w = canvas.width, h = canvas.height;
    if(w===0 || h===0) return;
    octx.clearRect(0,0,w,h);
    octx.globalCompositeOperation = 'lighter';
    points.forEach(p=>{
      const v = Math.max(0, Math.min(10, p.value));
      if(v<=0) return;
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      const a = Math.min(1, v/CENTER_ALPHA_AT);
      const grad = octx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, RADIUS_PX);
      grad.addColorStop(0, `rgba(0,0,0,${a})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      octx.fillStyle = grad;
      octx.fillRect(pt.x-RADIUS_PX, pt.y-RADIUS_PX, RADIUS_PX*2, RADIUS_PX*2);
    });
    octx.globalCompositeOperation = 'source-over';

    const imgData = octx.getImageData(0,0,w,h);
    const data = imgData.data;
    for(let i=0;i<data.length;i+=4){
      const alpha = data[i+3];
      if(alpha===0) continue;
      const t = alpha/255;
      const [r,g,b] = severityRgb(t);
      data[i]=r; data[i+1]=g; data[i+2]=b;
      data[i+3] = Math.min(230, 40 + alpha*0.8); // keep low-intensity areas faintly visible, cap peak opacity
    }
    ctx.clearRect(0,0,w,h);
    ctx.putImageData(imgData, 0, 0);
  }

  map.on('move zoom resize', redraw);

  return {
    setPoints(pts){ points = pts; redraw(); },
    setVisible(v){
      visible = v;
      canvas.style.display = v ? '' : 'none';
      if(v) redraw();
    },
  };
}

/* ---------- LEAFLET MAP ---------- */
let leafMap, markerRefs = {}, epicenterMarker = null, riverLine = null;
let damageHeat = null, damageLayerVisible = true;

function buildMap(){
  const lats = STATIONS.map(s=>s.lat), lons = STATIONS.map(s=>s.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);

  leafMap = L.map('mapDiv', {zoomControl:true, attributionControl:true, scrollWheelZoom:true});
  leafMap.fitBounds([[latMin-0.06, lonMin-0.06],[latMax+0.06, lonMax+0.06]]);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'&copy; OpenStreetMap contributors', maxZoom:14}).addTo(leafMap);

  // Damage heat map — driven by each station's own "tower reading", not a
  // synthetic interpolation grid. Added before station markers so it paints
  // underneath them (see createHeatCanvas above for why this is hand-rolled).
  damageHeat = createHeatCanvas(leafMap);

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

/* ---------- PHASE 2: RELAY MARKERS ON THE MAP ----------
   Network Extender drones daisy-chain from the working network's edge into
   the disaster corridor — each marker appears the instant its real
   deploy_at timestamp is reached during playback, and stays (a relay, once
   landed, doesn't go anywhere), with a dashed line tracing the chain as it grows. */
let relayState = {};
function buildRelayLayers(){
  CASES.forEach(c=>{
    const markers = {};
    (c.phase_2.relay_schedule||[]).forEach(r=>{
      const m = L.circleMarker([r.lat, r.lon], {radius:7, color:'#ffffff', weight:2, fillColor:'#2b7fb0', fillOpacity:0, className:'relay-marker'});
      m.bindTooltip(`Relay online: ${STATION_LOOKUP[r.station_id].name}`, {direction:'top', offset:[0,-8]});
      m.addTo(leafMap);
      markers[r.station_id] = m;
    });
    const polyline = L.polyline([], {color:'#2b7fb0', weight:2, dashArray:'5,5', opacity:0.8}).addTo(leafMap);
    relayState[c.case_id] = {markers, polyline, shownIds:new Set()};
  });
}
/* Survivor pins — the search schedule already carries a lat/lon and a
   found_at timestamp per survivor (jittered around the station so multiple
   pins at one zone don't stack exactly); each just needed a marker that
   appears the moment its real found_at passes, matching the relay treatment. */
let survivorState = {};
function buildSurvivorLayers(){
  CASES.forEach(c=>{
    const entries = [];
    (c.phase_2.search_zones||[]).forEach(z=>{
      z.survivors.forEach(s=>{
        const m = L.circleMarker([s.lat, s.lon], {radius:5, color:'#ffffff', weight:1.5, fillColor:'#0d9488', fillOpacity:0, className:'survivor-marker'});
        m.bindTooltip(`Survivor found — ${STATION_LOOKUP[z.station_id].name}, ${formatLabel(s.found_at)}`, {direction:'top', offset:[0,-6]});
        m.addTo(leafMap);
        entries.push({marker:m, found_at:s.found_at, shown:false});
      });
    });
    survivorState[c.case_id] = entries;
  });
}
function updateSurvivorLayers(currentIso){
  CASES.forEach(c=>{
    const entries = survivorState[c.case_id];
    if(!entries) return;
    entries.forEach(e=>{
      if(!e.shown && currentIso >= e.found_at){
        e.marker.setStyle({fillOpacity:1});
        e.shown = true;
      }
    });
  });
}

/* Phase 3 — one amber marker per affected station, appearing at its first
   delivery (medical or heavy) and staying, with a live-updating tooltip
   showing cumulative kg delivered so far (recomputed each tick since sorties
   keep arriving over the following days). */
let supplyState = {};
function buildSupplyLayers(){
  CASES.forEach(c=>{
    const stationIds = new Set([
      ...(c.phase_3.medical_deliveries||[]).map(m=>m.station_id),
      ...(c.phase_3.relief_sorties||[]).map(s=>s.station_id),
    ]);
    const markers = {};
    stationIds.forEach(id=>{
      const st = STATION_LOOKUP[id];
      // A hollow ring, not a filled dot — relay/survivor markers already sit
      // at this exact position, and a same-size filled circle added after
      // them would just paint over and hide them. A larger stroke-only ring
      // surrounds whatever's already there instead of covering it.
      const m = L.circleMarker([st.lat, st.lon], {radius:11, color:'#c98a1f', weight:2.5, fill:false, opacity:0, className:'supply-marker'});
      m.bindTooltip('', {direction:'top', offset:[0,-8]});
      m.addTo(leafMap);
      markers[id] = m;
    });
    supplyState[c.case_id] = markers;
  });
}
function updateSupplyLayers(currentIso){
  CASES.forEach(c=>{
    const markers = supplyState[c.case_id];
    if(!markers) return;
    const p3 = computePhase3(c, currentIso);
    const kgByStation = {};
    p3.medDelivered.forEach(m=> kgByStation[m.station_id] = (kgByStation[m.station_id]||0) + m.payload_kg);
    p3.sortiesDelivered.forEach(s=> kgByStation[s.station_id] = (kgByStation[s.station_id]||0) + s.payload_kg);
    Object.entries(markers).forEach(([stationId, marker])=>{
      const kg = kgByStation[stationId];
      if(kg){
        marker.setStyle({opacity:1});
        marker.setTooltipContent(`Supplies delivered: ${STATION_LOOKUP[stationId].name} — ${kg}kg so far`);
      }
    });
  });
}
function updateRelayLayers(currentIso){
  CASES.forEach(c=>{
    const rs = relayState[c.case_id];
    if(!rs) return;
    const deployed = (c.phase_2.relay_schedule||[]).filter(r=>currentIso >= r.deploy_at);
    deployed.forEach(r=>{
      if(!rs.shownIds.has(r.station_id)){
        rs.markers[r.station_id].setStyle({fillOpacity:1});
        rs.shownIds.add(r.station_id);
      }
    });
    rs.polyline.setLatLngs(deployed.map(r=>[r.lat, r.lon]));
  });
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
    row.innerHTML = `<span class="status-dot shape-${status}" style="background:${STATUS_COLOR[status]}"></span><span class="name">${s.name}</span><span class="val">${sample.rainfall.toFixed(1)}mm/hr</span>`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${s.name} — ${status} risk. Select to view details.`);
    row.addEventListener('click', ()=>{ state.selectedStation=s.id; renderStationList(); renderStationDetail(); });
    row.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); row.click(); } });
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
      <span class="status-dot shape-${status}" style="background:${STATUS_COLOR[status]}"></span>
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
let applySpeed = null; // assigned in initTransport; story mode reuses it to hit a target duration

function setPlayBtnState(playing){
  playBtn.textContent = playing ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', playing ? 'Pause the timeline' : 'Play the timeline');
}
function setFrame(idx){
  const clamped = Math.max(0, Math.min(TOTAL_FRAMES-1, Math.round(idx)));
  state.frameFloat = clamped;
  state.frameIndex = clamped;
  if(scrubTrack) scrubTrack.setAttribute('aria-valuenow', String(clamped));
  render();
}
function initTransport(){
  scrubTrack = document.getElementById('scrubTrack');
  scrubFill = document.getElementById('scrubFill');
  scrubPlayhead = document.getElementById('scrubPlayhead');
  timeLabelEl = document.getElementById('timeLabel');
  playBtn = document.getElementById('playBtn');

  scrubTrack.tabIndex = 0;
  scrubTrack.setAttribute('role', 'slider');
  scrubTrack.setAttribute('aria-label', 'Timeline scrubber');
  scrubTrack.setAttribute('aria-valuemin', '0');
  scrubTrack.setAttribute('aria-valuemax', String(TOTAL_FRAMES-1));
  scrubTrack.addEventListener('keydown', e=>{
    const step = e.shiftKey ? 24 : 1; // 4 hours per shift+arrow, 10 min per arrow
    if(e.key==='ArrowRight'){ e.preventDefault(); state.playing=false; setPlayBtnState(false); stopStoryMode(); setFrame(state.frameIndex+step); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); state.playing=false; setPlayBtnState(false); stopStoryMode(); setFrame(state.frameIndex-step); }
  });
  scrubTrack.addEventListener('pointerdown', e=>{
    state.playing=false; setPlayBtnState(false);
    stopStoryMode();
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
  // Speed: a slider (drag) and two number inputs (type either "speed ×" or
  // "finish in N seconds" — they stay in sync, whichever you last touched wins).
  const speedSlider = document.getElementById('speedSlider');
  const speedInput = document.getElementById('speedInput');
  const durationInput = document.getElementById('durationInput');
  applySpeed = function(newSpeed){
    state.speed = clampSpeed(newSpeed);
    speedSlider.value = speedToSlider(state.speed);
    speedInput.value = Math.round(state.speed*100)/100;
    durationInput.value = Math.round(((TOTAL_FRAMES-1)/(BASE_FPS_PER_X*state.speed))*10)/10;
  };
  speedSlider.addEventListener('input', ()=> applySpeed(sliderToSpeed(Number(speedSlider.value))));
  speedInput.addEventListener('change', ()=> applySpeed(Number(speedInput.value) || 1));
  durationInput.addEventListener('change', ()=>{
    const seconds = Number(durationInput.value);
    if(seconds > 0) applySpeed((TOTAL_FRAMES-1)/(BASE_FPS_PER_X*seconds));
  });
  applySpeed(state.speed);
  playBtn.addEventListener('click', ()=>{
    state.playing = !state.playing;
    setPlayBtnState(state.playing);
    state.lastTs = null;
  });
}

/* ---------- GUIDED "PLAY THE STORY" MODE ----------
   Captions are built once from each case's own real generated schedule
   (detection, first relay, connectivity restored, first survivor, search
   complete, first medical drop, last resupply sortie) — never scripted —
   and fired during normal playback by comparing the timeline position
   against these real timestamps, the same pattern every other live view
   in this app already uses. */
const STORY_TARGET_SECONDS = 50;
function buildStoryEvents(){
  const events = [];
  CASES.forEach(c=>{
    const label = DISASTER_LABEL[c.disaster_type] || c.disaster_type;
    events.push({at:c.detected_at, icon:'⚠', text:`${label} detected near ${c.location.region_label} — Case ${c.case_id} opens.`});

    const relays = c.phase_2.relay_schedule || [];
    if(relays.length){
      const first = relays.reduce((a,b)=> a.deploy_at<b.deploy_at ? a:b);
      events.push({at:first.deploy_at, icon:'📡', text:`First relay drone online for ${c.case_id} — connectivity chain begins extending into the corridor.`});
      if(c.phase_2.connectivity_complete_at){
        events.push({at:c.phase_2.connectivity_complete_at, icon:'✅', text:`Relay chain complete for ${c.case_id} — full connectivity restored to the corridor.`});
      }
    }
    const zones = c.phase_2.search_zones || [];
    const allSurvivors = zones.flatMap(z=>z.survivors||[]);
    if(allSurvivors.length){
      const first = allSurvivors.reduce((a,b)=> a.found_at<b.found_at ? a:b);
      events.push({at:first.found_at, icon:'🧭', text:`First survivor located during the search sweep for ${c.case_id}.`});
    }
    if(zones.length){
      const lastComplete = zones.reduce((a,b)=> a.search_complete>b.search_complete ? a:b);
      events.push({at:lastComplete.search_complete, icon:'🔎', text:`Search & rescue sweep complete for ${c.case_id}.`});
    }
    const meds = c.phase_3.medical_deliveries || [];
    if(meds.length){
      const first = meds.reduce((a,b)=> a.delivered_at<b.delivered_at ? a:b);
      events.push({at:first.delivered_at, icon:'💊', text:`First medical payload delivered for ${c.case_id}.`});
    }
    const sorties = c.phase_3.relief_sorties || [];
    if(sorties.length){
      const last = sorties.reduce((a,b)=> a.delivered_at>b.delivered_at ? a:b);
      events.push({at:last.delivered_at, icon:'📦', text:`Final relief sortie delivered for ${c.case_id} — sustained resupply complete.`});
    }
  });
  events.sort((a,b)=> a.at<b.at ? -1 : a.at>b.at ? 1 : 0);
  return events;
}

let storyCaptionHideTimer=null, storyCaptionRemoveTimer=null;
function showStoryCaption(icon, text){
  const el = document.getElementById('storyCaption');
  clearTimeout(storyCaptionHideTimer); clearTimeout(storyCaptionRemoveTimer);
  el.classList.remove('leaving');
  el.hidden = false;
  // restart the CSS entrance animation even if a caption is already showing
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  document.getElementById('storyCaptionIcon').textContent = icon;
  document.getElementById('storyCaptionText').textContent = text;
  storyCaptionHideTimer = setTimeout(()=>{
    el.classList.add('leaving');
    storyCaptionRemoveTimer = setTimeout(()=>{ el.hidden = true; el.classList.remove('leaving'); }, 320);
  }, 4200);
}
function checkStoryEvents(currentIso){
  if(!state.storyMode) return;
  while(state.storyNextIdx < state.storyEvents.length && currentIso >= state.storyEvents[state.storyNextIdx].at){
    const ev = state.storyEvents[state.storyNextIdx];
    showStoryCaption(ev.icon, ev.text);
    state.storyNextIdx++;
  }
}
function startStoryMode(){
  state.storyMode = true;
  state.storyNextIdx = 0;
  switchView('monitor');
  setFrame(0);
  if(applySpeed) applySpeed((TOTAL_FRAMES-1)/(BASE_FPS_PER_X*STORY_TARGET_SECONDS));
  state.playing = true;
  state.lastTs = null;
  if(playBtn) setPlayBtnState(true);
  const btn = document.getElementById('playStoryBtn');
  if(btn){ btn.classList.add('playing'); btn.textContent = '❚❚ Playing story…'; }
}
function stopStoryMode(){
  if(!state.storyMode) return;
  state.storyMode = false;
  const btn = document.getElementById('playStoryBtn');
  if(btn){ btn.classList.remove('playing'); btn.textContent = '▶ Play the Story'; }
}
function initStoryUI(){
  state.storyEvents = buildStoryEvents();

  const modal = document.getElementById('introModal');
  const dontShow = document.getElementById('introDontShow');
  const seen = localStorage.getItem('resq_intro_seen');
  if(!seen) modal.hidden = false;

  function dismissModal(){
    modal.hidden = true;
    if(dontShow.checked) localStorage.setItem('resq_intro_seen', '1');
  }
  document.getElementById('introPlayStory').addEventListener('click', ()=>{
    dismissModal();
    startStoryMode();
  });
  document.getElementById('introExplore').addEventListener('click', dismissModal);

  document.getElementById('playStoryBtn').addEventListener('click', ()=>{
    if(state.storyMode){
      stopStoryMode();
      state.playing = false;
      if(playBtn) setPlayBtnState(false);
    } else {
      startStoryMode();
    }
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
    // Ring style (not just fill color) also carries status, so critical vs.
    // normal still reads for red/green colorblind viewers on the map itself.
    ref.dot.setStyle({
      fillColor: STATUS_HEX[status],
      weight: status==='critical' ? 3 : status==='elevated' ? 2.5 : 2,
      color: status==='critical' ? '#5a1010' : '#ffffff',
      dashArray: status==='elevated' ? '2,2' : null,
    });
    if(status==='critical'){
      ref.pulse.setStyle({radius:14, color:STATUS_HEX[status], opacity: PREFERS_REDUCED_MOTION ? 0.8 : (0.6+0.4*Math.sin(performance.now()/180))});
    } else if(isSearchActiveAt(s.id, currentIso)){
      ref.pulse.setStyle({radius:12, color:'#2b7fb0', opacity: PREFERS_REDUCED_MOTION ? 0.7 : (0.5+0.35*Math.sin(performance.now()/220))});
    } else {
      ref.pulse.setStyle({radius:0, opacity:0});
    }
  });
  renderStationList();
  renderStationDetail();

  if(damageLayerVisible && damageHeat){
    damageHeat.setPoints(STATIONS.map(s => ({lat:s.lat, lon:s.lon, value:stationDamage(s.id, state.frameIndex)})));
  }

  const cbProb = CB_REGIONAL_DISPLAY[state.frameIndex] || 0;
  const eqProb = EQ_REGIONAL_DISPLAY[state.frameIndex] || 0;
  setGauge(gaugeFlood, cbProb, cbProb>=TRIGGER_THRESHOLD);
  setGauge(gaugeQuake, eqProb, eqProb>=TRIGGER_THRESHOLD);

  const frac = state.frameFloat/(TOTAL_FRAMES-1)*100; // continuous, for a smooth-gliding playhead
  scrubFill.style.width = frac+'%';
  scrubPlayhead.style.left = frac+'%';
  timeLabelEl.textContent = formatLabel(currentIso);
  if(scrubTrack) scrubTrack.setAttribute('aria-valuenow', String(state.frameIndex));
  document.getElementById('clock').textContent = 'SIM T+ '+formatLabel(currentIso);

  CASES.forEach(c=>{
    if(!state.revealedCases.has(c.case_id) && currentIso >= c.detected_at){
      revealCase(c);
      if(c.disaster_type==='earthquake' && epicenterMarker) epicenterMarker.addTo(leafMap);
    }
  });

  updateRelayLayers(currentIso);
  updateSurvivorLayers(currentIso);
  updateSupplyLayers(currentIso);
  checkStoryEvents(currentIso);

  // Keep whatever's currently on screen live during playback — otherwise
  // Phase 2's progress would only ever update the instant you first open it.
  if(state.currentView==='cases') renderCasesView();
  else if(state.currentView==='detail') refreshOpenCaseDetail();
}

function tick(ts){
  if(state.lastTs===null) state.lastTs = ts;
  const dt = (ts - state.lastTs)/1000;
  state.lastTs = ts;
  if(state.playing){
    state.frameFloat += state.speed*BASE_FPS_PER_X*dt;
    if(state.frameFloat>=TOTAL_FRAMES-1){ state.frameFloat=TOTAL_FRAMES-1; state.playing=false; setPlayBtnState(false); stopStoryMode(); }
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
/** Aggregate, live-computed "what has actually been achieved so far" across
    every revealed case — reinforces impact without inventing any number that
    isn't already sitting in real per-case schedule data. */
function renderImpactStrip(visibleCases, currentIso){
  const strip = document.getElementById('impactStrip');
  if(visibleCases.length===0){ strip.hidden = true; return; }
  strip.hidden = false;

  let survivorsFound=0, survivorsTotal=0, relaysDeployed=0, relaysTotal=0, kgDelivered=0, casesComplete=0;
  visibleCases.forEach(c=>{
    const p2 = computePhase2(c, currentIso);
    const p3 = computePhase3(c, currentIso);
    survivorsFound += p2.survivorsFound; survivorsTotal += p2.totalSurvivors;
    relaysDeployed += p2.deployedRelays.length; relaysTotal += p2.deployedRelays.length + p2.pendingRelays.length;
    kgDelivered += p3.totalKg;
    if(c.phase_1.status==='complete' && p2.status==='complete' && p3.status==='complete') casesComplete++;
  });

  const stats = [
    {val:`${survivorsFound}<small>/${survivorsTotal}</small>`, lbl:'Survivors found'},
    {val:`${relaysDeployed}<small>/${relaysTotal}</small>`, lbl:'Relay drones deployed'},
    {val:`${Math.round(kgDelivered)}<small>kg</small>`, lbl:'Relief delivered'},
    {val:`${casesComplete}<small>/${visibleCases.length}</small>`, lbl:'Cases fully resolved'},
  ];
  strip.innerHTML = stats.map(s=>`<div class="impact-stat"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`).join('');
}
function renderCasesView(){
  const content = document.getElementById('casesContent');
  const visibleCases = CASES.filter(c=>state.revealedCases.has(c.case_id));
  document.getElementById('casesSub').textContent = `${visibleCases.length} active`;
  renderImpactStrip(visibleCases, FRAME_ISO[state.frameIndex]);
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
          const currentIso = FRAME_ISO[state.frameIndex];
          const p2 = computePhase2(c, currentIso);
          const p3 = computePhase3(c, currentIso);
          return `<tr class="case-row" data-case="${c.case_id}">
            <td><div class="type-icon"><span class="shape"></span></div></td>
            <td>${c.title}</td>
            <td>${c.location.region_label}</td>
            <td style="font-family:var(--mono);color:var(--text-dim)">${formatLabel(c.detected_at)}</td>
            <td><span class="sev-badge" style="background:${sev.bg};color:${sev.fg}">${Math.round(c.severity.peak_probability*100)} — ${c.severity.severity_label.toUpperCase()}</span></td>
            <td><div class="phase-mini">
              <span class="seg ${phaseSegClass(c.phase_1.status)}" title="Phase 1 — Detection: confirmed ${formatLabel(c.detected_at)}"></span>
              <span class="seg ${phaseSegClass(p2.status)}" title="Phase 2 — Search &amp; Connectivity: ${p2.connectivityPct}% connectivity, ${p2.survivorsFound}/${p2.totalSurvivors} survivors found"></span>
              <span class="seg ${phaseSegClass(p3.status)}" title="Phase 3 — Relief Delivery: ${p3.medDelivered.length}/${p3.meds.length} zones supplied, ${Math.round(p3.totalKg)}kg delivered"></span>
            </div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  content.querySelectorAll('.case-row').forEach(row=>{
    const activate = ()=> openCaseDetail(row.dataset.case);
    row.addEventListener('click', activate);
    makeKeyboardActionable(row, activate);
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
  state.openCaseId = caseId;
  if(!state.activeDetailTab) state.activeDetailTab = 'p1';
  renderCaseDetail(c);
  switchView('detail');
}

/** Re-renders the currently-open case detail in place (called every tick while
    viewing it, so Phase 2's live progress updates during playback) — preserves
    whichever tab the user has selected rather than resetting to Phase 1. */
function refreshOpenCaseDetail(){
  if(!state.openCaseId) return;
  const c = CASES.find(x=>x.case_id===state.openCaseId); if(!c) return;
  renderCaseDetail(c);
}

/** Scans every remaining scheduled event across phase 2 + 3 for this case and
    returns a plain-language description of whichever real timestamp is
    coming up soonest — nothing scripted, just the nearest not-yet-reached
    entry in the case's own generated schedule. */
function nextMilestoneFor(c, currentIso){
  const name = (id) => (STATION_LOOKUP[id] && STATION_LOOKUP[id].name) || id;
  const candidates = [];
  (c.phase_2.relay_schedule||[]).forEach(r=>{
    if(currentIso < r.deploy_at) candidates.push({at:r.deploy_at, text:`Next relay deploying at ${name(r.station_id)} — ${formatLabel(r.deploy_at)}`});
  });
  if(c.phase_2.connectivity_complete_at && currentIso < c.phase_2.connectivity_complete_at){
    candidates.push({at:c.phase_2.connectivity_complete_at, text:`Full connectivity restored by ${formatLabel(c.phase_2.connectivity_complete_at)}`});
  }
  (c.phase_2.search_zones||[]).forEach(z=>{
    if(currentIso < z.search_start) candidates.push({at:z.search_start, text:`Search sweep starting at ${name(z.station_id)} — ${formatLabel(z.search_start)}`});
    (z.survivors||[]).forEach(s=>{
      if(currentIso < s.found_at) candidates.push({at:s.found_at, text:`Next survivor expected found near ${name(z.station_id)} — ${formatLabel(s.found_at)}`});
    });
    if(currentIso < z.search_complete) candidates.push({at:z.search_complete, text:`Search sweep at ${name(z.station_id)} completing ${formatLabel(z.search_complete)}`});
  });
  (c.phase_3.medical_deliveries||[]).forEach(m=>{
    if(currentIso < m.delivered_at) candidates.push({at:m.delivered_at, text:`Medical delivery arriving at ${name(m.station_id)} — ${formatLabel(m.delivered_at)}`});
  });
  (c.phase_3.relief_sorties||[]).forEach(s=>{
    if(currentIso < s.delivered_at) candidates.push({at:s.delivered_at, text:`Resupply sortie arriving at ${name(s.station_id)} — ${formatLabel(s.delivered_at)}`});
  });
  if(candidates.length===0) return null;
  candidates.sort((a,b)=> a.at<b.at ? -1 : a.at>b.at ? 1 : 0);
  return candidates[0].text;
}

/** Real elapsed-time-since-detection metrics for a single case — how fast
    the response actually moved, in its own generated schedule. Each stat
    only appears once the timeline has actually reached it (never reveals a
    future scheduled time early), same reveal discipline as everywhere else. */
function renderCaseImpactStrip(c, currentIso){
  const el = document.getElementById('caseImpactStrip');
  const relays = c.phase_2.relay_schedule || [];
  const firstRelay = relays.length ? relays.reduce((a,b)=> a.deploy_at<b.deploy_at?a:b) : null;
  const allSurvivors = (c.phase_2.search_zones||[]).flatMap(z=>z.survivors||[]);
  const firstSurvivor = allSurvivors.length ? allSurvivors.reduce((a,b)=> a.found_at<b.found_at?a:b) : null;
  const meds = c.phase_3.medical_deliveries || [];
  const firstMed = meds.length ? meds.reduce((a,b)=> a.delivered_at<b.delivered_at?a:b) : null;

  const stat = (reachedAt, label) => {
    const reached = reachedAt && currentIso >= reachedAt;
    return {val: reached ? formatDuration(minutesBetween(c.detected_at, reachedAt)) : null, lbl: label};
  };
  const stats = [
    stat(firstRelay && firstRelay.deploy_at, 'To first relay online'),
    stat(c.phase_2.connectivity_complete_at, 'To full connectivity'),
    stat(firstSurvivor && firstSurvivor.found_at, 'To first survivor found'),
    stat(firstMed && firstMed.delivered_at, 'To first relief delivered'),
  ];
  el.innerHTML = stats.map(s=>
    `<div class="impact-stat"><div class="val${s.val?'':' pending'}">${s.val || 'Pending'}</div><div class="lbl">${s.lbl}</div></div>`
  ).join('');
}

function renderCaseDetail(c){
  const currentIso = FRAME_ISO[state.frameIndex];
  const p2 = computePhase2(c, currentIso);
  const p3 = computePhase3(c, currentIso);

  document.getElementById('detailTitle').textContent = c.title;
  document.getElementById('detailDetected').textContent = 'Detected '+formatLabel(c.detected_at);
  document.getElementById('detailType').textContent = DISASTER_LABEL[c.disaster_type] || c.disaster_type;
  document.getElementById('detailSeverity').textContent = `Severity ${c.severity.severity_label} (peak ${Math.round(c.severity.peak_probability*100)}%)`;

  const nextEl = document.getElementById('nextMilestone');
  const nextText = nextMilestoneFor(c, currentIso);
  nextEl.hidden = !nextText;
  if(nextText) document.getElementById('nextMilestoneText').textContent = nextText;

  renderCaseImpactStrip(c, currentIso);

  const p1CorridorCount = (c.phase_1.damage_by_station ? Object.keys(c.phase_1.damage_by_station).length : null);
  const phases = [
    {n:1, label:'Detection & Surveillance', status:c.phase_1.status,
      sub: `Confirmed at ${formatLabel(c.detected_at)}`},
    {n:2, label:'Search & Connectivity', status:p2.status,
      sub: p2.status==='pending' ? 'Not yet started'
        : `${p2.connectivityPct}% connectivity · ${p2.survivorsFound}/${p2.totalSurvivors} survivors found`},
    {n:3, label:'Relief Delivery', status:p3.status,
      sub: p3.status==='pending' ? 'Awaiting connectivity'
        : `${p3.medDelivered.length}/${p3.meds.length} zones supplied · ${Math.round(p3.totalKg)}kg delivered`},
  ];
  document.getElementById('stepper').innerHTML = phases.map((p,i)=>{
    const cls = stepClass(p.status);
    const circle = stepCircle(p.status) || p.n;
    const line = i<phases.length-1 ? `<div class="line" style="${cls==='done'?'background:var(--green)':''}"></div>` : '';
    return `<div class="step ${cls}"><div class="circle">${circle}</div><div class="step-text"><div class="label">${p.n} · ${p.label}</div><div class="step-sub">${p.sub}</div></div></div>${line}`;
  }).join('');

  renderPhase1Tab(c);
  renderPhase2Tab(c, p2);
  renderPhase3Tab(c, p3, currentIso);

  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===state.activeDetailTab));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.toggle('active', t.id==='tab-'+state.activeDetailTab));
}

function phase2ZoneLabel(z){
  if(z.status==='complete') return `${z.found}/${z.total} found · completed ${formatLabel(z.search_complete)}`;
  if(z.status==='active') return `searching since ${formatLabel(z.search_start)} · ${z.found}/${z.total} found`;
  return `pending · starts ${formatLabel(z.search_start)}`;
}
function renderPhase2Tab(c, p2){
  const relayRows = c.phase_2.relay_schedule.map(r=>{
    const deployed = p2.deployedRelays.some(d=>d.station_id===r.station_id);
    const name = STATION_LOOKUP[r.station_id].name;
    return `<div class="fired-row"><span class="n">${deployed?'✓':'○'} ${name}</span><span class="v">${deployed?'online since '+formatLabel(r.deploy_at):'deploying '+formatLabel(r.deploy_at)}</span></div>`;
  }).join('');
  const zoneIcon = {pending:'○', active:'◐', complete:'✓'};
  const zoneRows = p2.zoneStatuses.map(z=>
    `<div class="fired-row"><span class="n">${zoneIcon[z.status]} ${STATION_LOOKUP[z.station_id].name}</span><span class="v">${phase2ZoneLabel(z)}</span></div>`
  ).join('');

  document.getElementById('tab-p2').innerHTML = `
    <p class="phase-explainer">
      <strong>Network Extender drones</strong> deploy one hop at a time — daisy-chaining outward from the edge of the
      still-working network into the disaster corridor — until connectivity is fully restored to every affected
      station. <strong>Search &amp; rescue teams</strong> sweep each affected zone for survivors in parallel, independent
      of network status. Restoring the network is what unlocks Phase 3: relief can't dispatch to a zone until that
      zone's own relay is online.
    </p>
    <div class="dgrid">
      <div class="card">
        <h3>Connectivity Restoration</h3>
        <div class="p2-metric">${p2.connectivityPct}%</div>
        <div class="p2-progress"><div class="p2-progress-fill" style="width:${p2.connectivityPct}%"></div></div>
        <div class="fired-list">${relayRows || '<span style="color:var(--text-faint);font-size:12px">No relay hops needed for this case.</span>'}</div>
      </div>
      <div class="card">
        <h3>Search &amp; Rescue</h3>
        <div class="p2-metric">${p2.survivorsFound} <span class="p2-metric-sub">/ ${p2.totalSurvivors} survivors found</span></div>
        <div class="fired-list" style="margin-top:14px">${zoneRows || '<span style="color:var(--text-faint);font-size:12px">No search zones for this case.</span>'}</div>
      </div>
    </div>`;
}

function renderPhase3Tab(c, p3, currentIso){
  const medRows = p3.meds.map(m=>{
    const delivered = p3.medDelivered.includes(m);
    const dispatched = currentIso >= m.dispatched_at;
    const name = STATION_LOOKUP[m.station_id].name;
    const icon = delivered ? '✓' : dispatched ? '◐' : '○';
    const label = delivered
      ? `delivered ${formatLabel(m.delivered_at)} · ${m.payload_kg}kg`
      : dispatched
        ? `en route since ${formatLabel(m.dispatched_at)} · ${m.payload_kg}kg`
        : `pending · dispatching ${formatLabel(m.dispatched_at)} · ${m.payload_kg}kg`;
    return `<div class="fired-row"><span class="n">${icon} ${name}</span><span class="v">${label}</span></div>`;
  }).join('');

  const byStation = {};
  p3.sorties.forEach(s=>{ (byStation[s.station_id] ??= []).push(s); });
  const sortieRows = Object.entries(byStation).map(([stationId, sorties])=>{
    const delivered = sorties.filter(s=>p3.sortiesDelivered.includes(s));
    const name = STATION_LOOKUP[stationId].name;
    const next = sorties.find(s=>!p3.sortiesDelivered.includes(s));
    let label;
    if(!next) label = `${delivered.length}/${sorties.length} sorties · last delivered ${formatLabel(sorties[sorties.length-1].delivered_at)}`;
    else if(currentIso >= next.dispatched_at) label = `${delivered.length}/${sorties.length} sorties · en route, arriving ${formatLabel(next.delivered_at)}`;
    else label = `${delivered.length}/${sorties.length} sorties · next dispatch ${formatLabel(next.dispatched_at)}`;
    return `<div class="fired-row"><span class="n">${delivered.length===sorties.length?'✓':'◐'} ${name}</span><span class="v">${label}</span></div>`;
  }).join('');

  document.getElementById('tab-p3').innerHTML = `
    <p class="phase-explainer">
      The instant a zone's relay comes online in Phase 2, a small <strong>Medical Supply drone</strong> makes one
      precision delivery there — connectivity first, then relief, in the same operation. <strong>Heavy Payload
      drones</strong> then run repeat resupply sorties (food, water, blankets) roughly every 20-30 hours for as long
      as the response continues, for sustained multi-day aid rather than a single drop.
    </p>
    <div class="dgrid">
      <div class="card">
        <h3>Medical Supply Delivery</h3>
        <div class="p2-metric">${p3.medDelivered.length} <span class="p2-metric-sub">/ ${p3.meds.length} zones supplied</span></div>
        <div class="fired-list" style="margin-top:14px">${medRows || '<span style="color:var(--text-faint);font-size:12px">No medical deliveries scheduled for this case.</span>'}</div>
      </div>
      <div class="card">
        <h3>Relief Sorties (Heavy Payload)</h3>
        <div class="p2-metric">${p3.totalKg} <span class="p2-metric-sub">kg total aid delivered</span></div>
        <div class="fired-list" style="margin-top:14px">${sortieRows || '<span style="color:var(--text-faint);font-size:12px">No relief sorties scheduled for this case.</span>'}</div>
      </div>
    </div>`;
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
    .map(([k,v])=>tooltipChip(`${k}=${v}`, k)).join(' ');
  const modelNameChip = tooltipChip(c.phase_1.model, c.phase_1.model);

  const damageCardHtml = damageAssessmentCardHtml(c.phase_1.damage_by_station);

  document.getElementById('tab-p1').innerHTML = `
    <div class="dgrid">
      <div class="card">
        <h3>${DISASTER_LABEL[c.disaster_type]||c.disaster_type} Probability — Trigger Window</h3>
        ${sparkSvg(probSeries.length?probSeries:[0,0], '#e1594f', 'height:120px')}
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--text-faint);margin-top:6px">
          <span>${formatLabel(FRAME_ISO[lo])}</span><span>Crossed threshold (${Math.round(TRIGGER_THRESHOLD*100)}%) → ${formatLabel(c.detected_at)}</span>
        </div>
        <div class="model-note">${c.phase_1.summary}<br>Model: ${modelNameChip} ${modelParams}</div>
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
   assessment) at the moment of detection — miniature soft/blurred blobs at
   each tower's real relative position, echoing the live heat layer's look. */
function damageAssessmentCardHtml(damageByStation){
  if(!damageByStation) return '';
  const lats = STATIONS.map(s=>s.lat), lons = STATIONS.map(s=>s.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const shortCode = (name) => name.slice(0,3).toUpperCase();

  const layers = STATIONS.map(s=>{
    const v = damageByStation[s.id] ?? 0;
    const xPct = ((s.lon-lonMin)/((lonMax-lonMin)||1))*100;
    const yPct = (1-(s.lat-latMin)/((latMax-latMin)||1))*100; // invert so north is up
    const size = 34 + v*9;
    const glow = `<div style="position:absolute;left:${xPct}%;top:${yPct}%;width:${size}px;height:${size}px;transform:translate(-50%,-50%);border-radius:50%;background:${damageColor(v)};filter:blur(11px);opacity:0.9"></div>`;
    // Exact station position (a solid dot) plus an always-visible label —
    // the blurred glow alone reads as an unlabeled abstract painting to
    // anyone who hasn't hovered over it, so the number/name is never hidden
    // behind an interaction.
    const dot = `<div style="position:absolute;left:${xPct}%;top:${yPct}%;width:7px;height:7px;transform:translate(-50%,-50%);border-radius:50%;background:${damageColor(v)};border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);z-index:2"></div>`;
    const labelBelow = yPct < 78;
    // Clamp the label's horizontal anchor near the left/right edges instead
    // of always centering it on the marker — a centered label on an
    // edge-hugging station (real geography puts several right at the box
    // border) would otherwise render half off-canvas, invisible under
    // overflow:hidden.
    const xAnchor = xPct < 12 ? '0%' : xPct > 88 ? '-100%' : '-50%';
    const label = `<div title="${s.name}: ${v.toFixed(1)} / 10" style="position:absolute;left:${xPct}%;top:${yPct}%;transform:translate(${xAnchor}, ${labelBelow ? '6px' : '-100%'});margin-top:${labelBelow?'6px':'-6px'};z-index:3;font-family:var(--mono);font-size:9.5px;font-weight:700;white-space:nowrap;background:rgba(20,24,30,.72);color:#fff;padding:2px 5px;border-radius:4px;letter-spacing:.02em">${shortCode(s.name)} ${v.toFixed(1)}</div>`;
    return glow + dot + label;
  }).join('');

  return `
    <div class="card" style="grid-column:1/-1">
      <h3>Damage / Infrastructure Assessment (simulated CV pass)</h3>
      <p style="font-size:12px;color:var(--text-dim);line-height:1.55;margin:2px 0 12px;max-width:620px">
        Stands in for a computer-vision pass over post-disaster aerial/satellite imagery: each station's surroundings
        get a structural-damage severity score from <strong>0</strong> (minimal) to <strong>10</strong> (severe), read
        directly from that station's own raw sensor intensity. This is deliberately a separate signal from the
        detection probability above — that one asks "is this statistically anomalous," this one asks
        "how physically severe does it look on the ground."
      </p>
      <div style="position:relative;width:100%;max-width:420px;height:210px;background:var(--panel-2);border:1px solid var(--border-soft);border-radius:8px;overflow:hidden">
        <div style="position:absolute;top:8px;left:10px;font-family:var(--mono);font-size:10px;font-weight:700;color:var(--text-faint);z-index:3">N ↑</div>
        ${layers}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px;color:var(--text-dim)">
        <span>0</span><div class="damage-scale-bar" style="flex:none"></div><span>10</span>
        <span style="margin-left:10px">Labels show each station's 3-letter code and severity at time of detection — hover a marker for the full name.</span>
      </div>
    </div>`;
}

// Div-based controls (nav tabs, detail tabbar, back link) aren't natively
// focusable/actionable by keyboard — make each one behave like a real
// button for anyone not using a mouse.
function makeKeyboardActionable(el, onActivate){
  el.tabIndex = 0;
  if(!el.hasAttribute('role')) el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' || e.key===' '){ e.preventDefault(); onActivate(); }
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.nav-tab').forEach(tab=>{
    const activate = ()=> switchView(tab.dataset.view);
    tab.addEventListener('click', activate);
    makeKeyboardActionable(tab, activate);
  });
  const backLink = document.getElementById('backToCases');
  backLink.addEventListener('click', ()=> switchView('cases'));
  makeKeyboardActionable(backLink, ()=> switchView('cases'));
  document.getElementById('damageToggle').addEventListener('change', (e)=>{
    damageLayerVisible = e.target.checked;
    damageHeat.setVisible(damageLayerVisible);
  });
  document.getElementById('tabbar').addEventListener('click', e=>{
    const tab = e.target.closest('.tab'); if(!tab) return;
    state.activeDetailTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t===tab));
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
  });
  document.querySelectorAll('.tab').forEach(tab=>{
    makeKeyboardActionable(tab, ()=> tab.click());
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
    buildRelayLayers();
    buildSurvivorLayers();
    buildSupplyLayers();
    const probPanel = document.getElementById('probPanel');
    gaugeFlood = buildGauge(probPanel, 'Cloudburst / Flood Risk');
    gaugeQuake = buildGauge(probPanel, 'Seismic Risk');
    initTransport();
    initStoryUI();
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
