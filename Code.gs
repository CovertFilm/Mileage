/**
 * NFC Mileage Tracker — Google Apps Script backend
 * -------------------------------------------------
 * Container-bound script for a Google Sheet.
 *
 *  - Phone (Tasker) calls  <WEBAPP_URL>?action=scan&k=TOKEN&t=EPOCH_MS&lat=..&lng=..&rid=UNIQUE
 *    The server decides whether the scan STARTS or ENDS a trip (state lives in the sheet).
 *  - Reply is plain text:  event|miles|message|editUrl
 *  - Opening  <WEBAPP_URL>?k=TOKEN  gives a small mobile "app": trip list, add, edit, delete.
 *
 * First-time setup: see SETUP.md. Short version: run setup() once, then Deploy > Web app
 * (Execute as: Me, Who has access: Anyone), then run showConfig() to read your token.
 */

// ───────────────────────── Config ─────────────────────────
const HEADERS = ['id', 'date', 'start_time', 'end_time', 'start_lat', 'start_lng', 'start_addr',
  'end_lat', 'end_lng', 'end_addr', 'miles', 'purpose', 'status', 'start_rid', 'end_rid', 'notes', 'updated'];
const TRIPS = 'Trips';
const DASH = 'Dashboard';
const STALE_HOURS = 10;      // an open trip older than this is treated as "forgot to end"
const MIN_MILES = 0.1;       // shorter than this gets flagged "check"
const MAX_LIST = 40;         // trips shown in the app list
const DEFAULT_PURPOSE = 'Business';

// ───────────────────────── Entry point ─────────────────────────
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!authed_(p.k)) return respond_('error|Unauthorized (bad or missing token)', p);
  try {
    if (p.action === 'ping') return respond_('ok|pong', p);
    if (p.action === 'scan') return respond_(handleScan_(p), p);
    if (p.action === 'roundtrip') return respond_(handleRoundTrip_(p), p);
    return page_(p);
  } catch (err) {
    return respond_('error|' + (err && err.message ? err.message : err), p);
  }
}

function text_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

/** Plain text, or JSONP (callback=fn) so the web page can still read the reply if the browser blocks cross-site fetch. */
function respond_(s, p) {
  const cb = String((p && p.callback) || '');
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + JSON.stringify(s) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return text_(s);
}

function authed_(k) {
  const t = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!(k && t && k === t);
}

function need_(k) {
  if (!authed_(k)) throw new Error('Unauthorized');
}

// ───────────────────────── Scan handling ─────────────────────────
function handleScan_(p) {
  const lat = parseFloat(p.lat);
  const lng = parseFloat(p.lng);
  if (!isFinite(lat) || !isFinite(lng)) throw new Error('No location in request');
  let t = p.t ? new Date(parseInt(p.t, 10)) : new Date();
  if (isNaN(t.getTime())) t = new Date();
  const rid = String(p.rid || '');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = tripsSheet_();
    const rows = readRows_(sh);

    // Idempotency: a retried/queued request must not create a second event.
    if (rid) {
      const dup = rows.filter(function (r) { return r.start_rid === rid || r.end_rid === rid; })[0];
      if (dup) return dup.start_rid === rid ? startReply_(dup) : endReply_(dup);
    }

    // Flag forgotten trips.
    const staleMs = STALE_HOURS * 3600 * 1000;
    let notice = '';
    rows.forEach(function (r) {
      if (r.status === 'open' && t.getTime() - new Date(r.start_time).getTime() > staleMs) {
        r.status = 'unclosed';
        r.notes = joinNotes_(r.notes, 'Never ended');
        writeRow_(sh, r._row, r);
        notice = 'Previous trip was never ended (flagged). ';
      }
    });

    const open = rows.filter(function (r) { return r.status === 'open'; }).pop();

    if (!open) {
      // ── START ──
      const o = {
        id: Utilities.getUuid().slice(0, 8),
        date: dayOf_(t),
        start_time: t,
        start_lat: lat,
        start_lng: lng,
        start_addr: geocode_(lat, lng),
        purpose: DEFAULT_PURPOSE,
        status: 'open',
        start_rid: rid
      };
      appendRow_(sh, o);
      return reply_('start', '', notice + 'Trip started ' + fmtTime_(t) + ' · ' + shortAddr_(o.start_addr), o.id);
    }

    // ── END ──
    let miles;
    let note = '';
    try {
      miles = routeMiles_({ lat: Number(open.start_lat), lng: Number(open.start_lng) }, { lat: lat, lng: lng });
    } catch (err) {
      miles = haversineMiles_(Number(open.start_lat), Number(open.start_lng), lat, lng) * 1.25;
      note = 'Straight-line estimate x1.25 (route lookup failed: ' + err.message + ')';
    }
    miles = Math.round(miles * 10) / 10;
    open.end_time = t;
    open.end_lat = lat;
    open.end_lng = lng;
    open.end_addr = geocode_(lat, lng);
    open.miles = miles;
    open.status = miles < MIN_MILES ? 'check' : 'done';
    open.end_rid = rid;
    open.notes = joinNotes_(open.notes, note);
    writeRow_(sh, open._row, open);
    return endReply_(open);
  } finally {
    lock.releaseLock();
  }
}

function startReply_(r) {
  return reply_('start', '', 'Trip started ' + fmtTime_(r.start_time) + ' · ' + shortAddr_(r.start_addr), r.id);
}

function endReply_(r) {
  const m = Number(r.miles) || 0;
  let msg;
  if (isRoundTrip_(r)) msg = 'Round trip logged: ' + m.toFixed(1) + ' mi. Tap to edit.';
  else if (r.status === 'check') msg = 'Trip logged: ' + m.toFixed(1) + ' mi. Looks off, tap to fix.';
  else msg = 'Trip logged: ' + m.toFixed(1) + ' mi. Tap to edit.';
  return reply_('end', m, msg, r.id);
}

/** Reply format: event|miles|message|editUrl|tripId */
function reply_(event, miles, msg, id) {
  const m = miles === '' ? '' : (Math.round(miles * 10) / 10).toFixed(1);
  return [event, m, String(msg).replace(/\|/g, '/'), editUrl_(id), id].join('|');
}

// ───────────────────────── Round trip toggle ─────────────────────────
const RT_TAG = 'Round trip';

function noteParts_(notes) {
  return String(notes || '').split(' | ').filter(function (s) { return s !== ''; });
}

function isRoundTrip_(r) {
  return noteParts_(r.notes).indexOf(RT_TAG) >= 0;
}

/**
 * action=roundtrip&id=TRIP&on=1|0
 * on=1 doubles the logged miles (once); on=0 undoes it. Idempotent, so retries are safe.
 */
function handleRoundTrip_(p) {
  const id = String(p.id || '').replace(/[^a-zA-Z0-9-]/g, '');
  const on = String(p.on) !== '0';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = tripsSheet_();
    const r = readRows_(sh).filter(function (x) { return x.id === id; })[0];
    if (!r) throw new Error('Trip not found');
    const m = Number(r.miles);
    if (r.miles === '' || !isFinite(m)) throw new Error('Trip has no miles yet');
    const has = isRoundTrip_(r);
    if (on && !has) {
      r.miles = Math.round(m * 2 * 10) / 10;
      r.notes = joinNotes_(r.notes, RT_TAG);
      if (r.status === 'check' && r.miles >= MIN_MILES) r.status = 'done';
      writeRow_(sh, r._row, r);
    } else if (!on && has) {
      r.miles = Math.round(m / 2 * 10) / 10;
      r.notes = noteParts_(r.notes).filter(function (s) { return s !== RT_TAG; }).join(' | ');
      writeRow_(sh, r._row, r);
    }
    return endReply_(r);
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── Maps helpers ─────────────────────────
function geocode_(lat, lng) {
  try {
    const res = Maps.newGeocoder().reverseGeocode(lat, lng);
    if (res.status === 'OK' && res.results && res.results.length) return res.results[0].formatted_address;
  } catch (err) { /* fall through */ }
  return lat.toFixed(5) + ', ' + lng.toFixed(5);
}

/** a, b: {lat,lng} or an address string. Returns driving miles. */
function routeMiles_(a, b) {
  const f = Maps.newDirectionFinder();
  if (typeof a === 'string') f.setOrigin(a); else f.setOrigin(a.lat, a.lng);
  if (typeof b === 'string') f.setDestination(b); else f.setDestination(b.lat, b.lng);
  const res = f.setMode(Maps.DirectionFinder.Mode.DRIVING).getDirections();
  if (res.status !== 'OK' || !res.routes || !res.routes.length) throw new Error('No route (' + res.status + ')');
  let meters = 0;
  res.routes[0].legs.forEach(function (l) { meters += l.distance.value; });
  return meters / 1609.344;
}

function haversineMiles_(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ───────────────────────── Sheet helpers ─────────────────────────
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Run setup() first');
  return SpreadsheetApp.openById(id);
}

function tripsSheet_() {
  const sh = ss_().getSheetByName(TRIPS);
  if (!sh) throw new Error('Trips sheet missing. Run setup().');
  return sh;
}

function readRows_(sh) {
  const n = sh.getLastRow();
  if (n < 2) return [];
  const vals = sh.getRange(2, 1, n - 1, HEADERS.length).getValues();
  return vals.map(function (v, i) {
    const o = { _row: i + 2 };
    HEADERS.forEach(function (h, j) { o[h] = v[j]; });
    return o;
  });
}

function rowValues_(o) {
  return HEADERS.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
}

function writeRow_(sh, rowNum, o) {
  o.updated = new Date();
  sh.getRange(rowNum, 1, 1, HEADERS.length).setValues([rowValues_(o)]);
}

function appendRow_(sh, o) {
  o.updated = new Date();
  sh.appendRow(rowValues_(o));
}

function dayOf_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fmtTime_(d) {
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'h:mm a');
}

function fmtDay_(d) {
  if (!d) return '';
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function shortAddr_(a) {
  return String(a || '').split(',').slice(0, 2).join(',').trim();
}

function joinNotes_(a, b) {
  if (!b) return a || '';
  return a ? a + ' | ' + b : b;
}

function editUrl_(id) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return ScriptApp.getService().getUrl() + '?k=' + token + '&page=edit&id=' + id;
}

// ───────────────────────── API for the web page ─────────────────────────
function api_list(k) {
  need_(k);
  const rows = readRows_(tripsSheet_());
  const now = new Date();
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yStart = new Date(now.getFullYear(), 0, 1);
  let month = 0, ytd = 0, monthTrips = 0;
  rows.forEach(function (r) {
    const m = Number(r.miles);
    const d = new Date(r.date);
    if (!(m > 0) || isNaN(d.getTime())) return;
    if (d >= yStart) { ytd += m; }
    if (d >= mStart) { month += m; monthTrips++; }
  });
  rows.sort(function (a, b) { return new Date(b.start_time) - new Date(a.start_time); });
  return {
    month: month, ytd: ytd, monthTrips: monthTrips,
    trips: rows.slice(0, MAX_LIST).map(function (r) {
      return {
        id: r.id, date: fmtDay_(r.date), time: r.start_time ? fmtTime_(r.start_time) : '',
        from: shortAddr_(r.start_addr), to: shortAddr_(r.end_addr),
        miles: r.miles === '' ? '' : Number(r.miles).toFixed(1),
        status: r.status, purpose: r.purpose
      };
    })
  };
}

function api_get(k, id) {
  need_(k);
  const r = readRows_(tripsSheet_()).filter(function (x) { return x.id === id; })[0];
  if (!r) return null;
  return {
    id: r.id, date: fmtDay_(r.date), start_addr: r.start_addr, end_addr: r.end_addr,
    miles: r.miles === '' ? '' : Number(r.miles), purpose: r.purpose, notes: r.notes, status: r.status,
    start_time: r.start_time ? fmtTime_(r.start_time) : '', end_time: r.end_time ? fmtTime_(r.end_time) : ''
  };
}

function parseDay_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error('Bad date');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function milesFrom_(t) {
  const m = parseFloat(t.miles);
  if (isFinite(m) && m >= 0) return Math.round(m * 10) / 10;
  if (t.start_addr && t.end_addr) return Math.round(routeMiles_(t.start_addr, t.end_addr) * 10) / 10;
  return '';
}

function api_save(k, id, t) {
  need_(k);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = tripsSheet_();
    const r = readRows_(sh).filter(function (x) { return x.id === id; })[0];
    if (!r) throw new Error('Trip not found (already deleted?)');
    const day = parseDay_(t.date);
    if (fmtDay_(r.date) !== t.date) {
      const move = function (dt) {
        return dt ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), new Date(dt).getHours(), new Date(dt).getMinutes()) : '';
      };
      r.start_time = move(r.start_time);
      r.end_time = move(r.end_time);
      r.date = day;
    }
    r.start_addr = t.start_addr || '';
    r.end_addr = t.end_addr || '';
    r.miles = milesFrom_(t);
    r.purpose = t.purpose || '';
    r.notes = t.notes || '';
    if (r.miles !== '' && r.status !== 'manual') r.status = 'done';
    writeRow_(sh, r._row, r);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function api_add(k, t) {
  need_(k);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const day = parseDay_(t.date);
    const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0);
    const o = {
      id: Utilities.getUuid().slice(0, 8), date: day, start_time: noon,
      start_addr: t.start_addr || '', end_addr: t.end_addr || '',
      miles: milesFrom_(t), purpose: t.purpose || '', notes: t.notes || '', status: 'manual'
    };
    appendRow_(tripsSheet_(), o);
    return o.id;
  } finally {
    lock.releaseLock();
  }
}

function api_delete(k, id) {
  need_(k);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = tripsSheet_();
    const r = readRows_(sh).filter(function (x) { return x.id === id; })[0];
    if (r) sh.deleteRow(r._row);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────── Web page (the "app") ─────────────────────────
function page_(p) {
  const route = p.page === 'edit' ? 'edit' : (p.page === 'new' ? 'new' : 'list');
  const id = String(p.id || '').replace(/[^a-zA-Z0-9-]/g, '');
  const html = PAGE_HTML
    .replace('__K__', function () { return JSON.stringify(p.k); })
    .replace('__ROUTE__', function () { return JSON.stringify(route); })
    .replace('__ID__', function () { return JSON.stringify(id); });
  return HtmlService.createHtmlOutput(html)
    .setTitle('Mileage')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// NOTE: client code below deliberately avoids backticks and dollar-brace (String.raw template).
const PAGE_HTML = String.raw`<!doctype html>
<html><head><base target="_top"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#111827;--mut:#6b7280;--card:#f3f4f6;--line:#e5e7eb;--acc:#2563eb;--bad:#dc2626;--warn:#b45309}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#f3f4f6;--mut:#9ca3af;--card:#1b1e25;--line:#2a2f3a;--acc:#60a5fa;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.4 system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:560px;margin:0 auto;padding:16px 16px 80px}
h1{font-size:20px;margin:4px 0 12px}
.mut{color:var(--mut)}
.stats{display:flex;gap:8px;margin-bottom:12px}
.stats div{flex:1;background:var(--card);border-radius:12px;padding:10px 12px}
.stats b{display:block;font-size:22px}
.stats span{font-size:12px;color:var(--mut)}
button{font:inherit;border:0;border-radius:12px;padding:12px 14px;background:var(--card);color:var(--fg);width:100%;margin-top:8px}
button.pri{background:var(--acc);color:#fff;font-weight:600}
button.bad{background:transparent;color:var(--bad);border:1px solid var(--bad)}
button.back{width:auto;background:transparent;color:var(--acc);padding:6px 0;margin:0 0 6px}
.row{display:flex;justify-content:space-between;gap:10px;padding:12px 4px;border-bottom:1px solid var(--line)}
.row .l{min-width:0}.row .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .m{font-weight:600;white-space:nowrap}
.tag{font-size:12px;color:var(--warn)}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}
input,textarea{width:100%;font:inherit;padding:11px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.two{display:flex;gap:8px}.two>*{flex:1}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:20px;opacity:0;transition:opacity .2s;pointer-events:none}
</style></head>
<body><div class="wrap"><div id="app"></div></div><div id="toast"></div>
<script>
var K = __K__, ROUTE = __ROUTE__, ID = __ID__;
var app = document.getElementById('app');

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.style.opacity=1;setTimeout(function(){t.style.opacity=0;},2400);}
function call(name,args,cb){
  var r=google.script.run.withSuccessHandler(cb).withFailureHandler(function(e){toast('Error: '+((e&&e.message)||e));});
  r[name].apply(r,[K].concat(args));
}
function today(){var d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10);}

app.addEventListener('click',function(e){
  var el=e.target.closest('[data-go]'); if(!el) return;
  show(el.getAttribute('data-go'), el.getAttribute('data-id')||'');
});

function show(route,id){
  ROUTE=route; ID=id||'';
  if(route==='list') viewList(); else if(route==='new') viewForm(null); else viewEdit(ID);
  window.scrollTo(0,0);
}

function viewList(){
  app.innerHTML='<p class="mut">Loading…</p>';
  call('api_list',[],function(d){
    var h='<h1>Mileage</h1><div class="stats">'
      +'<div><b>'+d.month.toFixed(1)+'</b><span>mi this month</span></div>'
      +'<div><b>'+d.ytd.toFixed(1)+'</b><span>mi this year</span></div>'
      +'<div><b>'+d.monthTrips+'</b><span>trips this month</span></div></div>'
      +'<button class="pri" data-go="new">+ Add trip manually</button>';
    if(!d.trips.length) h+='<p class="mut">No trips yet. Scan your tag to start one.</p>';
    d.trips.forEach(function(t){
      var flag=(t.status==='check'||t.status==='unclosed'||t.status==='open')?'<div class="tag">'+(t.status==='open'?'In progress':'Needs a look')+'</div>':'';
      h+='<div class="row" data-go="edit" data-id="'+esc(t.id)+'"><div class="l"><div class="t">'
        +esc(t.from||'?')+' → '+esc(t.to||'…')+'</div><div class="mut" style="font-size:13px">'
        +esc(t.date)+' '+esc(t.time)+(t.purpose?' · '+esc(t.purpose):'')+'</div>'+flag+'</div>'
        +'<div class="m">'+(t.miles===''?'—':esc(t.miles)+' mi')+'</div></div>';
    });
    app.innerHTML=h;
  });
}

function viewEdit(id){
  app.innerHTML='<p class="mut">Loading…</p>';
  call('api_get',[id],function(t){
    if(!t){app.innerHTML='<p>Trip not found (maybe deleted).</p><button data-go="list">Back</button>';return;}
    viewForm(t);
  });
}

function viewForm(t){
  var isNew=!t;
  t=t||{date:today(),purpose:'Business',miles:'',start_addr:'',end_addr:'',notes:''};
  var h='<button class="back" data-go="list">‹ Trips</button><h1>'+(isNew?'Add trip':'Edit trip')+'</h1>';
  if(!isNew&&(t.status==='open'||t.status==='unclosed'||t.status==='check')){
    h+='<p class="tag">'+(t.status==='open'?'This trip is still open (no end scan yet). Enter miles to close it.':
      t.status==='unclosed'?'This trip was never ended. Enter miles or delete it.':'Distance looks off. Check the miles.')+'</p>';
  }
  h+='<label>Date</label><input id="f_date" type="date" value="'+esc(t.date)+'">'
    +'<label>From</label><input id="f_from" value="'+esc(t.start_addr)+'">'
    +'<label>To</label><input id="f_to" value="'+esc(t.end_addr)+'">'
    +'<label>Miles'+(isNew?' (leave blank to calculate from the addresses)':'')+'</label>'
    +'<div class="two"><input id="f_miles" type="number" step="0.1" min="0" inputmode="decimal" value="'+esc(t.miles)+'">'
    +'<button id="dbl" type="button" style="margin:0">× 2 round trip</button></div>'
    +'<label>Purpose</label><input id="f_purpose" value="'+esc(t.purpose)+'">'
    +'<label>Notes</label><textarea id="f_notes" rows="2">'+esc(t.notes)+'</textarea>'
    +'<button class="pri" id="save">Save</button>'
    +(isNew?'':'<button class="bad" id="del">Delete trip</button>');
  app.innerHTML=h;

  document.getElementById('dbl').onclick=function(){
    var m=parseFloat(document.getElementById('f_miles').value);
    if(isFinite(m)) document.getElementById('f_miles').value=(Math.round(m*2*10)/10);
  };
  document.getElementById('save').onclick=function(){
    var b=document.getElementById('save'); b.disabled=true; b.textContent='Saving…';
    var data={date:document.getElementById('f_date').value,start_addr:document.getElementById('f_from').value,
      end_addr:document.getElementById('f_to').value,miles:document.getElementById('f_miles').value,
      purpose:document.getElementById('f_purpose').value,notes:document.getElementById('f_notes').value};
    var done=function(){toast('Saved');show('list');};
    if(isNew) call('api_add',[data],done); else call('api_save',[t.id,data],done);
    setTimeout(function(){b.disabled=false;b.textContent='Save';},6000);
  };
  var del=document.getElementById('del');
  if(del){
    var armed=false;
    del.onclick=function(){
      if(!armed){armed=true;del.textContent='Tap again to delete';setTimeout(function(){armed=false;del.textContent='Delete trip';},3000);return;}
      call('api_delete',[t.id],function(){toast('Deleted');show('list');});
    };
  }
}

show(ROUTE, ID);
</script></body></html>`;

// ───────────────────────── Setup, dashboard, triggers ─────────────────────────
/** Run once from the editor. Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('This script is not attached to a Sheet. Open your Google Sheet, choose Extensions > Apps Script, ' +
      'and paste the code there (do not create the script from script.google.com).');
  }
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  ensureToken_();

  // Trips sheet
  let sh = ss.getSheetByName(TRIPS);
  if (!sh) sh = ss.insertSheet(TRIPS);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('B2:B').setNumberFormat('yyyy-mm-dd');
  sh.getRange('C2:D').setNumberFormat('yyyy-mm-dd h:mm AM/PM');
  sh.getRange('E2:F').setNumberFormat('0.00000');
  sh.getRange('H2:I').setNumberFormat('0.00000');
  sh.getRange('K2:K').setNumberFormat('0.0');
  sh.getRange('Q2:Q').setNumberFormat('yyyy-mm-dd h:mm AM/PM');
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=OR($M2="check",$M2="unclosed")')
      .setBackground('#FDE2E2').setRanges([sh.getRange('A2:Q')]).build()
  ]);

  buildDashboard_(ss);
  installTriggers_();
  showConfig();
}

/** Returns the secret token, creating it if it doesn't exist yet. */
function ensureToken_() {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty('TOKEN');
  if (!t) {
    t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('TOKEN', t);
  }
  return t;
}

/**
 * Logs your token. Run any time.
 * MT_URL is NOT taken from here: copy the /exec URL from Deploy > Manage deployments.
 * (Run from the editor, this shows the /dev test URL, which only works for you, signed in.)
 */
function showConfig() {
  const token = ensureToken_();
  if (!PropertiesService.getScriptProperties().getProperty('SHEET_ID')) {
    Logger.log('WARNING: setup() has not run yet. Run setup() first.');
  }
  Logger.log('TOKEN (MT_KEY in Tasker): ' + token);
  Logger.log('MT_URL = the Web app URL from Deploy > Manage deployments. It ends in /exec.');
  Logger.log('Home-screen app link: <that /exec URL>?k=' + token);
  Logger.log('Test link:            <that /exec URL>?action=ping&k=' + token + '   (should show: ok|pong)');
}

function buildDashboard_(ss) {
  let d = ss.getSheetByName(DASH);
  if (d) { d.clear(); d.getCharts().forEach(function (c) { d.removeChart(c); }); } else { d = ss.insertSheet(DASH, 0); }
  const monthStart = 'DATE(YEAR(TODAY()),MONTH(TODAY()),1)';
  const inMonth = function (cell) {
    return 'Trips!$B:$B,">="&' + cell + ',Trips!$B:$B,"<"&EDATE(' + cell + ',1)';
  };

  d.getRange('A1').setValue('Mileage Dashboard').setFontSize(18).setFontWeight('bold');
  const kpis = [
    ['This month (mi)', '=SUMIFS(Trips!$K:$K,' + inMonth(monthStart) + ')'],
    ['Year to date (mi)', '=SUMIFS(Trips!$K:$K,Trips!$B:$B,">="&DATE(YEAR(TODAY()),1,1))'],
    ['Trips this month', '=COUNTIFS(' + inMonth(monthStart) + ',Trips!$K:$K,"<>")'],
    ['Avg trip (mi)', '=IFERROR(B3/B5,0)'],
    ['Needs attention', '=COUNTIF(Trips!$M:$M,"check")+COUNTIF(Trips!$M:$M,"unclosed")'],
    ['Rate ($/mi), enter current IRS rate', ''],
    ['Deduction YTD ($)', '=B4*B8']
  ];
  d.getRange(3, 1, kpis.length, 2).setValues(kpis);
  d.getRange('B3:B4').setNumberFormat('0.0');
  d.getRange('B6').setNumberFormat('0.0');
  d.getRange('B8').setBackground('#FFF9C4').setNumberFormat('0.000');
  d.getRange('B9').setNumberFormat('$#,##0.00');
  d.getRange('A3:A9').setFontWeight('bold');

  d.getRange('A12:D12').setValues([['Month', 'Trips', 'Miles', 'Est. deduction ($)']]).setFontWeight('bold');
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const r = 13 + i;
    const a = i === 0 ? '=EDATE(' + monthStart + ',-11)' : '=EDATE(A' + (r - 1) + ',1)';
    rows.push([
      a,
      '=COUNTIFS(' + inMonth('A' + r) + ',Trips!$K:$K,"<>")',
      '=SUMIFS(Trips!$K:$K,' + inMonth('A' + r) + ')',
      '=C' + r + '*$B$8'
    ]);
  }
  d.getRange(13, 1, 12, 4).setFormulas(rows);
  d.getRange('A13:A24').setNumberFormat('mmm yyyy');
  d.getRange('C13:C24').setNumberFormat('0.0');
  d.getRange('D13:D24').setNumberFormat('$#,##0.00');
  d.setColumnWidths(1, 1, 230);
  d.setColumnWidths(2, 3, 110);

  const chart = d.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(d.getRange('A12:A24')).addRange(d.getRange('C12:C24'))
    .setNumHeaders(1).setOption('title', 'Miles per month').setOption('legend', { position: 'none' })
    .setPosition(2, 6, 0, 0).build();
  d.insertChart(chart);
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkStale') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkStale').timeBased().everyHours(1).create();
}

/** Hourly: email once if a trip has been open too long (forgot the end scan). */
function checkStale() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = tripsSheet_();
    const now = new Date();
    readRows_(sh).forEach(function (r) {
      if (r.status !== 'open') return;
      if (now.getTime() - new Date(r.start_time).getTime() < STALE_HOURS * 3600 * 1000) return;
      if (String(r.notes).indexOf('reminded') >= 0) return;
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Mileage: a trip is still open',
        'Trip started ' + fmtDay_(r.start_time) + ' ' + fmtTime_(r.start_time) + ' at ' + shortAddr_(r.start_addr) +
        ' was never ended.\nFix it here: ' + editUrl_(r.id));
      r.notes = joinNotes_(r.notes, 'reminded');
      writeRow_(sh, r._row, r);
    });
  } finally {
    lock.releaseLock();
  }
}
