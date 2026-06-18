// ── State ──────────────────────────────────────────────────────────────────
let currentRouteId = null;
let products = [];
let stops = [];
let map = null;
let markers = [];
const STATUS_CYCLE = ['รอส่ง', 'กำลังส่ง', 'ส่งแล้ว', 'ยกเลิก'];

// ── Init ───────────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }

function formatDateThai(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

async function init() {
  const dateInput = document.getElementById('mainDate');
  dateInput.value = todayStr();
  products = await fetch('/api/products').then(r => r.json());
  initMap();
  initMobileTabs();
  await loadRoute();
}

// ── Map ────────────────────────────────────────────────────────────────────
let myLocMarker = null;
let myLocCircle = null;
let myLocWatchId = null;
let followMe = false;

function initMap() {
  map = L.map('map').setView([13.75, 100.5], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  }).addTo(map);
  map.on('contextmenu', async e => {
    const { lat, lng } = e.latlng;
    const name = prompt('ชื่อลูกค้า / จุดส่ง:');
    if (!name) return;
    await addStopFromSearch(name, lat, lng);
  });
}

function startMyLocation() {
  if (!navigator.geolocation) { alert('เบราว์เซอร์นี้ไม่รองรับ GPS'); return; }
  const btn = document.getElementById('myLocBtn');
  if (myLocWatchId !== null) {
    // Toggle off
    navigator.geolocation.clearWatch(myLocWatchId);
    myLocWatchId = null;
    followMe = false;
    if (myLocMarker) { myLocMarker.remove(); myLocMarker = null; }
    if (myLocCircle) { myLocCircle.remove(); myLocCircle = null; }
    btn.textContent = '📍 ตำแหน่งฉัน';
    btn.style.background = '';
    return;
  }
  btn.textContent = '⏳ รอ GPS...';
  myLocWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const myIcon = L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;background:#3182ce;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(49,130,206,.35)"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9]
    });
    if (!myLocMarker) {
      myLocMarker = L.marker([lat, lng], { icon: myIcon, zIndexOffset: 1000 }).addTo(map).bindPopup('📍 ตำแหน่งของคุณ');
      myLocCircle = L.circle([lat, lng], { radius: accuracy, color: '#3182ce', fillColor: '#3182ce', fillOpacity: 0.1, weight: 1 }).addTo(map);
      map.setView([lat, lng], 15);
      followMe = true;
    } else {
      myLocMarker.setLatLng([lat, lng]);
      myLocCircle.setLatLng([lat, lng]).setRadius(accuracy);
    }
    if (followMe) map.panTo([lat, lng]);
    btn.textContent = '🔵 ติดตามตำแหน่ง';
    btn.style.background = '#2b6cb0';
  }, err => {
    btn.textContent = '📍 ตำแหน่งฉัน';
    alert('ไม่สามารถเข้าถึง GPS: ' + err.message);
    myLocWatchId = null;
  }, { enableHighAccuracy: true, maximumAge: 5000 });
}

let routeLayer = null;
let legLabels = [];

function updateMap() {
  // Clear old layers
  markers.forEach(m => m.remove());
  markers = [];
  if (routeLayer) { routeLayer.remove(); routeLayer = null; }
  legLabels.forEach(l => l.remove());
  legLabels = [];

  const withCoords = stops.filter(s => s.lat && s.lng && s.status !== 'ยกเลิก');
  if (!withCoords.length) {
    document.getElementById('mapStatus').textContent = '📍 ยังไม่มีตำแหน่งที่อยู่';
    document.getElementById('gmapsBtn').style.display = 'none';
    return;
  }

  // Draw markers
  withCoords.forEach((s, i) => {
    const color = s.status === 'ส่งแล้ว' ? '#38a169' : s.status === 'กำลังส่ง' ? '#3182ce' : '#e53e3e';
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};color:white;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.5)">${s.seq || i+1}</div>`,
      iconSize: [30, 30], iconAnchor: [15, 15]
    });
    const m = L.marker([s.lat, s.lng], { icon, draggable: true })
      .bindPopup(`<b>${s.seq || i+1}. ${s.customer_name}</b><br><small>${s.address}</small><br><small style="color:#e53e3e">🖱️ ลากเพื่อแก้ตำแหน่ง</small>`)
      .addTo(map);
    m.on('dragend', async e => {
      const { lat, lng } = e.target.getLatLng();
      await fetch(`/api/stops/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lng }) });
      s.lat = lat; s.lng = lng;
      updateMap();
    });
    markers.push(m);
  });

  const group = L.featureGroup(markers);
  map.fitBounds(group.getBounds().pad(0.25));
  document.getElementById('gmapsBtn').style.display = '';

  if (withCoords.length < 2) {
    document.getElementById('mapStatus').textContent = `📍 ${withCoords.length} จุดส่ง`;
    return;
  }

  // Fetch actual road route from OSRM
  document.getElementById('mapStatus').textContent = '⏳ คำนวณเส้นทาง...';
  fetchRoute(withCoords);
}

async function fetchRoute(pts) {
  try {
    const coords = pts.map(s => `${s.lng},${s.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes.length) throw new Error('no route');

    const route = data.routes[0];
    const totalKm = (route.distance / 1000).toFixed(1);
    const totalMin = Math.round(route.duration / 60);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    const timeStr = hours > 0 ? `${hours} ชม. ${mins} นาที` : `${mins} นาที`;

    // Draw route line
    routeLayer = L.geoJSON(route.geometry, {
      style: { color: '#2b6cb0', weight: 5, opacity: 0.85 }
    }).addTo(map);

    // Show distance labels between legs
    route.legs.forEach((leg, i) => {
      const from = pts[i], to = pts[i + 1];
      const midLat = (from.lat + to.lat) / 2;
      const midLng = (from.lng + to.lng) / 2;
      const km = (leg.distance / 1000).toFixed(1);
      const legMin = Math.round(leg.duration / 60);
      const label = L.divIcon({
        className: '',
        html: `<div style="background:white;border:1px solid #2b6cb0;border-radius:6px;padding:2px 6px;font-size:11px;font-weight:600;color:#2b6cb0;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)">${km} กม. · ${legMin} น.</div>`,
        iconAnchor: [30, 12]
      });
      const ll = L.marker([midLat, midLng], { icon: label, interactive: false }).addTo(map);
      legLabels.push(ll);
    });

    document.getElementById('mapStatus').textContent =
      `🛣 รวม ${totalKm} กม. · ${timeStr} · ${pts.length} จุดส่ง`;

  } catch(e) {
    // Fallback to straight-line polyline
    const latlngs = pts.map(s => [s.lat, s.lng]);
    routeLayer = L.polyline(latlngs, { color: '#3182ce', weight: 4, opacity: 0.6, dashArray: '8,4' }).addTo(map);
    document.getElementById('mapStatus').textContent = `📍 ${pts.length} จุดส่ง (ไม่สามารถคำนวณเส้นทางได้)`;
  }
}

function buildGoogleMapsUrl(originLat, originLng) {
  const withCoords = stops.filter(s => s.lat && s.lng && s.status !== 'ยกเลิก' && s.status !== 'ส่งแล้ว');
  if (!withCoords.length) return null;
  const pts = withCoords.map(s => `${s.lat},${s.lng}`);
  const origin = (originLat != null) ? `${originLat},${originLng}` : pts[0];
  const dest = pts[pts.length - 1];
  const waypoints = pts.slice(0, -1);
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
  if (waypoints.length) url += `&waypoints=${waypoints.join('|')}`;
  return url;
}

function openGoogleMaps() {
  const withCoords = stops.filter(s => s.lat && s.lng && s.status !== 'ยกเลิก' && s.status !== 'ส่งแล้ว');
  if (!withCoords.length) return alert('ไม่มีตำแหน่งที่อยู่ หรือส่งครบแล้ว');
  const btn = document.getElementById('gmapsBtn');
  btn.textContent = '⏳ รอ GPS...';
  btn.disabled = true;
  if (!navigator.geolocation) {
    window.open(buildGoogleMapsUrl(), '_blank');
    btn.textContent = '🗺 Google Maps'; btn.disabled = false; return;
  }
  navigator.geolocation.getCurrentPosition(pos => {
    const url = buildGoogleMapsUrl(pos.coords.latitude, pos.coords.longitude);
    window.open(url, '_blank');
    btn.textContent = '🗺 Google Maps'; btn.disabled = false;
  }, () => {
    // GPS denied — open without origin
    window.open(buildGoogleMapsUrl(), '_blank');
    btn.textContent = '🗺 Google Maps'; btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 6000 });
}

// ── Address Search Bar ─────────────────────────────────────────────────────
let searchTimer = null;
let searchResults = [];

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('addressSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { hideSuggestions(); return; }
    searchTimer = setTimeout(() => fetchSuggestions(q), 400);
  });
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 200));
});

async function fetchSuggestions(q) {
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q + ' ประเทศไทย')}`);
    searchResults = await res.json();
    showSuggestions(searchResults);
  } catch(e) { hideSuggestions(); }
}

function showSuggestions(results) {
  const box = document.getElementById('searchSuggestions');
  if (!results.length) { box.innerHTML = '<div class="suggestion-item"><span class="sugg-text"><span class="sugg-addr">ไม่พบที่อยู่</span></span></div>'; return; }
  box.innerHTML = results.map((r, i) => {
    const name = r.name || r.display_name.split(',')[0];
    const addr = r.display_name;
    return `<div class="suggestion-item" onclick="selectSuggestion(${i})">
      <span class="sugg-icon">📍</span>
      <span class="sugg-text"><div class="sugg-name">${name}</div><div class="sugg-addr">${addr}</div></span>
    </div>`;
  }).join('');
}

function hideSuggestions() {
  document.getElementById('searchSuggestions').innerHTML = '';
}

function selectSuggestion(idx) {
  const r = searchResults[idx];
  document.getElementById('addressSearch').value = r.display_name;
  hideSuggestions();
  addStopFromSearch(r.display_name, parseFloat(r.lat), parseFloat(r.lon));
}

function onSearchKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); searchAndAdd(); }
}

// Extract lat/lng from Google Maps URL formats
function extractCoordsFromGmapsUrl(url) {
  // Format: @14.1234,100.5678
  let m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // Format: q=14.1234,100.5678 or ll=14.1234,100.5678
  m = url.match(/[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // Format: !3d14.1234!4d100.5678
  m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return null;
}

async function handlePaste(e) {
  const text = (e.clipboardData || window.clipboardData).getData('text').trim();
  if (!text.includes('google.com/maps') && !text.includes('maps.app.goo.gl') && !text.includes('goo.gl/maps')) return;
  e.preventDefault();
  document.getElementById('addressSearch').value = text;
  document.getElementById('mapStatus').textContent = '⏳ กำลังอ่านพิกัด...';

  // Try extracting directly from URL first
  let coords = extractCoordsFromGmapsUrl(text);

  // If short URL or no coords found → ask server to resolve
  if (!coords) {
    try {
      const res = await fetch('/api/resolve-gmaps?url=' + encodeURIComponent(text));
      const d = await res.json();
      if (d.lat) coords = { lat: d.lat, lng: d.lng };
    } catch(e) {}
  }

  if (!coords) {
    document.getElementById('mapStatus').textContent = '❌ ไม่สามารถอ่านพิกัดจาก link นี้ได้';
    return;
  }

  const name = prompt('ชื่อลูกค้า / จุดส่ง:') || 'จุดส่ง';
  document.getElementById('addressSearch').value = '';
  await addStopFromSearch(name, coords.lat, coords.lng);
}

async function searchAndAdd() {
  const q = document.getElementById('addressSearch').value.trim();
  if (!q) return;
  hideSuggestions();
  document.getElementById('mapStatus').textContent = '⏳ กำลังค้นหา...';
  const coords = await geocodeAddress(q);
  if (!coords) {
    document.getElementById('mapStatus').textContent = '❌ ไม่พบที่อยู่ — ลองพิมพ์ละเอียดขึ้น';
    return;
  }
  await addStopFromSearch(q, coords.lat, coords.lng);
}

async function addStopFromSearch(address, lat, lng) {
  // Center map on found location first
  map.setView([lat, lng], 14);

  // Add a temporary pin so user can see before saving
  const tempIcon = L.divIcon({
    className: '',
    html: `<div style="background:#e53e3e;color:white;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)">+</div>`,
    iconSize: [30,30], iconAnchor: [15,15]
  });
  const tmp = L.marker([lat, lng], { icon: tempIcon }).addTo(map)
    .bindPopup(`<b>กำลังเพิ่ม...</b><br>${address}`).openPopup();

  // Save to DB
  const body = {
    route_id: currentRouteId,
    seq: stops.length + 1,
    customer_name: address.split(',')[0].trim(),
    address,
    lat, lng,
    qty1:0, qty2:0, qty3:0, qty4:0, qty5:0, qty6:0,
    price: 0, note: '', status: 'รอส่ง'
  };
  const res = await fetch('/api/stops', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const { id } = await res.json();
  stops.push({ ...body, id });

  tmp.remove();
  document.getElementById('addressSearch').value = '';
  renderTable();
  updateMap();
}

// ── Geocode ────────────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  // Try progressively shorter queries for better match rate
  const queries = [address + ' ประเทศไทย'];
  // Add fallback: last 2 segments (e.g. "อ.เมือง จ.ชลบุรี")
  const parts = address.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 3) queries.push(parts.slice(-3).join(' ') + ' ประเทศไทย');
  if (parts.length > 1) queries.push(parts.slice(-2).join(' ') + ' ประเทศไทย');

  for (const q of queries) {
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch(e) {}
  }
  return null;
}

// ── Route ──────────────────────────────────────────────────────────────────
async function loadRoute() {
  const date = document.getElementById('mainDate').value;
  document.getElementById('routeDateDisplay').textContent = formatDateThai(date);

  const data = await fetch(`/api/routes/date?date=${date}`).then(r => r.json());
  currentRouteId = data.route.id;
  stops = data.stops;

  document.getElementById('driverName').value = data.route.driver_name || '';
  document.getElementById('driverPhone').value = data.route.driver_phone || '';
  document.getElementById('truckNumber').value = data.route.truck_number || '';

  renderProductHeaders();
  renderTable();
  updateMap();
}

function saveRouteHeader() {
  if (!currentRouteId) return;
  fetch(`/api/routes/${currentRouteId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driver_name: document.getElementById('driverName').value,
      driver_phone: document.getElementById('driverPhone').value,
      truck_number: document.getElementById('truckNumber').value,
    })
  });
}

function changeDate(delta) {
  const input = document.getElementById('mainDate');
  const d = new Date(input.value + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  input.value = d.toISOString().split('T')[0];
  loadRoute();
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderProductHeaders() {
  const tr = document.getElementById('productHeaders');
  tr.innerHTML = products.map(p => `<th>${p.name}</th>`).join('');
}

let dragSrcIdx = null;

function renderTable() {
  const tbody = document.getElementById('stopTableBody');
  const tfoot = document.getElementById('stopTableFoot');
  const empty = document.getElementById('emptyState');
  tbody.innerHTML = '';

  const active = stops.filter(s => s.status !== 'ยกเลิก');
  if (!stops.length) { empty.style.display = 'block'; tfoot.innerHTML = ''; return; }
  empty.style.display = 'none';

  stops.forEach((s, i) => {
    const qtyCells = [1,2,3,4,5,6].map(n => {
      const v = s[`qty${n}`];
      return `<td class="qty-cell ${v ? '' : 'qty-zero'}">${v || ''}</td>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.idx = i;
    if (s.status === 'ยกเลิก') tr.style.opacity = '0.45';
    tr.innerHTML = `
      <td class="col-seq">
        <div class="seq-wrap">
          <span class="drag-handle no-print" title="ลากเพื่อเรียงลำดับ">⠿</span>
          <span class="seq-num">${i + 1}</span>
        </div>
      </td>
      <td class="col-addr">
        <div class="addr-name">${s.customer_name}</div>
        ${s.note ? `<div class="addr-note">${s.note}</div>` : ''}
        ${s.address && s.address !== s.customer_name ? `<div class="addr-sub">${s.address}</div>` : ''}
        <span class="status-badge status-${s.status}" onclick="cycleStatus(${s.id},'${s.status}')">${s.status}</span>
      </td>
      ${qtyCells}
      <td class="col-price">${s.price ? s.price.toLocaleString() : ''}</td>
      <td class="col-action no-print">
        <div class="action-btns">
          <button class="btn btn-edit" onclick="editStop(${s.id})">แก้ไข</button>
          <button class="btn btn-delete" onclick="deleteStop(${s.id})">ลบ</button>
        </div>
      </td>`;

    tr.addEventListener('dragstart', e => {
      dragSrcIdx = i;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    });
    tr.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      tr.classList.add('drag-over');
    });
    tr.addEventListener('drop', e => {
      e.preventDefault();
      const targetIdx = parseInt(tr.dataset.idx);
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
      const moved = stops.splice(dragSrcIdx, 1)[0];
      stops.splice(targetIdx, 0, moved);
      stops.forEach((s, idx) => { s.seq = idx + 1; });
      saveNewOrder();
      renderTable();
      updateMap();
    });

    tbody.appendChild(tr);
  });

  addTouchDrag(tbody);

  // Footer totals
  const totals = [1,2,3,4,5,6].map(n => active.reduce((a,s) => a + (s[`qty${n}`]||0), 0));
  const totalPrice = active.reduce((a,s) => a + (s.price||0), 0);
  tfoot.innerHTML = `<tr>
    <td colspan="2" style="text-align:right;font-weight:700">รวม</td>
    ${totals.map(t => `<td class="qty-cell">${t || ''}</td>`).join('')}
    <td class="col-price">${totalPrice ? totalPrice.toLocaleString() : ''}</td>
    <td class="no-print"></td>
  </tr>`;
}

// ── Stop CRUD ──────────────────────────────────────────────────────────────
function openStopModal(stopData = null) {
  document.getElementById('stopDrawerTitle').textContent = stopData ? 'แก้ไขจุดส่ง' : 'เพิ่มจุดส่ง';
  document.getElementById('stopId').value = stopData?.id || '';
  document.getElementById('stopCustomer').value = stopData?.customer_name || '';
  document.getElementById('stopAddress').value = stopData?.address || '';
  document.getElementById('stopNote').value = stopData?.note || '';
  document.getElementById('stopPrice').value = stopData?.price || '';
  document.getElementById('stopStatus').value = stopData?.status || 'รอส่ง';

  // Qty inputs
  const qtyGrid = document.getElementById('qtyGrid');
  qtyGrid.innerHTML = products.map((p, i) => `
    <div class="qty-item">
      <label>${p.name}</label>
      <input type="number" id="qty${i+1}" min="0" step="0.5" value="${stopData ? (stopData[`qty${i+1}`]||'') : ''}">
    </div>`).join('');

  document.getElementById('stopDrawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('open');
  setTimeout(() => document.getElementById('stopCustomer').focus(), 100);
}

function closeDrawer() {
  document.getElementById('stopDrawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('open');
}

function editStop(id) {
  const s = stops.find(x => x.id === id);
  if (s) openStopModal(s);
}

async function deleteStop(id) {
  if (!confirm('ลบจุดส่งนี้?')) return;
  await fetch(`/api/stops/${id}`, { method: 'DELETE' });
  stops = stops.filter(s => s.id !== id);
  renderTable();
  updateMap();
}

async function saveStop(e) {
  e.preventDefault();
  const id = document.getElementById('stopId').value;
  const address = document.getElementById('stopAddress').value;

  // Find existing lat/lng or geocode
  let lat = null, lng = null;
  const existing = stops.find(s => s.id == id);
  if (existing?.lat) { lat = existing.lat; lng = existing.lng; }
  else if (address) {
    const coords = await geocodeAddress(address);
    if (coords) { lat = coords.lat; lng = coords.lng; }
  }

  const body = {
    route_id: currentRouteId,
    seq: stops.length + 1,
    customer_name: document.getElementById('stopCustomer').value,
    address, lat, lng,
    note: document.getElementById('stopNote').value,
    price: parseFloat(document.getElementById('stopPrice').value) || 0,
    status: document.getElementById('stopStatus').value,
  };
  [1,2,3,4,5,6].forEach(n => { body[`qty${n}`] = parseFloat(document.getElementById('qty'+n)?.value) || 0; });

  if (id) {
    await fetch(`/api/stops/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const idx = stops.findIndex(s => s.id == id);
    stops[idx] = { ...stops[idx], ...body, id: parseInt(id) };
  } else {
    const res = await fetch('/api/stops', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const { id: newId } = await res.json();
    stops.push({ ...body, id: newId });
  }

  closeDrawer();
  renderTable();
  updateMap();
}

async function saveNewOrder() {
  await Promise.all(stops.map((s, i) =>
    fetch(`/api/stops/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: i + 1 })
    })
  ));
}

async function cycleStatus(id, current) {
  const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(current) + 1) % STATUS_CYCLE.length];
  await fetch(`/api/stops/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: next }) });
  const s = stops.find(x => x.id === id);
  if (s) s.status = next;
  renderTable();
  updateMap();
}

// ── Products ───────────────────────────────────────────────────────────────
function openProductModal() {
  document.getElementById('productInputs').innerHTML = products.map(p => `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="width:20px;font-weight:700;color:#4a5568">${p.id}</span>
      <input id="pname${p.id}" value="${p.name}" style="flex:1;padding:7px 9px;border:1px solid #cbd5e0;border-radius:5px;font-family:inherit">
    </div>`).join('');
  document.getElementById('productModal').classList.add('open');
}

async function saveProducts() {
  const updated = products.map(p => ({ id: p.id, name: document.getElementById(`pname${p.id}`).value || p.name }));
  await fetch('/api/products', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(updated) });
  products = updated;
  renderProductHeaders();
  closeModal('productModal');
}

// ── Modal helpers ──────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function closeOnBackdrop(e, id) { if (e.target === document.getElementById(id)) closeModal(id); }

// ── Mobile Tabs ────────────────────────────────────────────────────────────
function switchTab(tab) {
  const isMobile = window.innerWidth <= 768;
  if (!isMobile) return;
  document.getElementById('tabMap').classList.toggle('active', tab === 'map');
  document.getElementById('tabList').classList.toggle('active', tab === 'list');
  document.getElementById('mapPanel').classList.toggle('tab-active', tab === 'map');
  document.getElementById('sheetPanel').classList.toggle('tab-active', tab === 'list');
  if (tab === 'map') setTimeout(() => map.invalidateSize(), 50);
}

function initMobileTabs() {
  if (window.innerWidth <= 768) {
    document.getElementById('mapPanel').classList.add('tab-active');
  } else {
    document.getElementById('mapPanel').classList.remove('tab-active');
    document.getElementById('sheetPanel').classList.remove('tab-active');
  }
}

window.addEventListener('resize', () => {
  initMobileTabs();
  map.invalidateSize();
});

// ── Touch Drag ─────────────────────────────────────────────────────────────
function addTouchDrag(tbody) {
  let touchSrcIdx = null;
  let touchPlaceholder = null;
  let ghostEl = null;

  function getRowFromY(y) {
    const rows = [...tbody.querySelectorAll('tr[data-idx]')];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return row;
    }
    return null;
  }

  tbody.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', e => {
      const tr = handle.closest('tr');
      touchSrcIdx = parseInt(tr.dataset.idx);
      tr.classList.add('dragging');

      // Create ghost
      ghostEl = tr.cloneNode(true);
      ghostEl.style.cssText = `position:fixed;width:${tr.offsetWidth}px;opacity:0.85;background:white;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;z-index:9999;border-radius:6px;`;
      document.body.appendChild(ghostEl);

      // Placeholder
      touchPlaceholder = document.createElement('tr');
      touchPlaceholder.style.cssText = 'background:#bee3f8;height:' + tr.offsetHeight + 'px;outline:2px dashed #3182ce;';
      tr.parentNode.insertBefore(touchPlaceholder, tr);

      const touch = e.touches[0];
      ghostEl.style.left = (touch.clientX - 20) + 'px';
      ghostEl.style.top = (touch.clientY - 20) + 'px';
      e.preventDefault();
    }, { passive: false });

    handle.addEventListener('touchmove', e => {
      if (touchSrcIdx === null || !ghostEl) return;
      const touch = e.touches[0];
      ghostEl.style.left = (touch.clientX - 20) + 'px';
      ghostEl.style.top = (touch.clientY - 20) + 'px';

      const targetRow = getRowFromY(touch.clientY);
      if (targetRow && targetRow !== touchPlaceholder) {
        const targetIdx = parseInt(targetRow.dataset.idx);
        if (!isNaN(targetIdx)) {
          const rect = targetRow.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (touch.clientY < mid) {
            targetRow.parentNode.insertBefore(touchPlaceholder, targetRow);
          } else {
            targetRow.parentNode.insertBefore(touchPlaceholder, targetRow.nextSibling);
          }
        }
      }
      e.preventDefault();
    }, { passive: false });

    handle.addEventListener('touchend', e => {
      if (touchSrcIdx === null) return;
      if (ghostEl) { ghostEl.remove(); ghostEl = null; }

      const rows = [...tbody.querySelectorAll('tr[data-idx]')];
      rows.forEach(r => r.classList.remove('dragging'));

      if (touchPlaceholder) {
        // Find new position
        const allRows = [...tbody.children];
        const newIdx = allRows.indexOf(touchPlaceholder);
        touchPlaceholder.remove();

        if (newIdx !== -1 && newIdx !== touchSrcIdx && !(newIdx === touchSrcIdx + 1)) {
          const insertIdx = newIdx > touchSrcIdx ? newIdx - 1 : newIdx;
          const moved = stops.splice(touchSrcIdx, 1)[0];
          stops.splice(insertIdx, 0, moved);
          stops.forEach((s, i) => { s.seq = i + 1; });
          saveNewOrder();
          renderTable();
          updateMap();
        }
        touchPlaceholder = null;
      }
      touchSrcIdx = null;
    });
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
init();
