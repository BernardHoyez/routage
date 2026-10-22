/* routage — interface */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmtKm = m => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const COLORS = ['#e4572e', '#29a3e0', '#f2c14e', '#7bc47f', '#c77dff', '#ff8fab'];

  const wmts = (layer, matrix, fmt, maxZ) => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
    '&STYLE=normal&TILEMATRIXSET=' + matrix + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=' + fmt,
    { maxZoom: 19, maxNativeZoom: maxZ, attribution: '© IGN' });
  const BASES = {
    osm: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
    plan: () => wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'PM', 'image/png', 18),
    ortho: () => wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'PM_0_19', 'image/jpeg', 19)
  };

  let map, baseLayer, startMarker, start = null, cands = [], lines = [], sel = -1, abortCtl = null;

  /* ---------- carte ---------- */
  map = L.map('map', { zoomControl: true }).setView([46.6, 2.5], 6);
  function setBase(k) {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = BASES[k]().addTo(map);
    baseLayer.bringToBack();
    try { localStorage.setItem('routage.base', k); } catch (e) { }
  }
  let savedBase = 'osm';
  try { savedBase = localStorage.getItem('routage.base') || 'osm'; } catch (e) { }
  if (!BASES[savedBase]) savedBase = 'osm';
  $('base').value = savedBase; setBase(savedBase);
  $('base').addEventListener('change', e => setBase(e.target.value));

  /* ---------- départ ---------- */
  function setStart(lon, lat, pan) {
    start = [lon, lat];
    if (!startMarker) {
      startMarker = L.marker([lat, lon], { draggable: true, icon: L.divIcon({ className: 'start-icon', html: 'D', iconSize: [28, 28] }) }).addTo(map);
      startMarker.on('dragend', () => { const p = startMarker.getLatLng(); setStart(p.lng, p.lat, false); });
    } else startMarker.setLatLng([lat, lon]);
    $('lat').value = lat.toFixed(5); $('lon').value = lon.toFixed(5);
    $('start-readout').textContent = 'Départ : ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
    $('btn-run').disabled = false;
    if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 14));
    clearResults();
    try { localStorage.setItem('routage.start', JSON.stringify(start)); } catch (e) { }
  }
  map.on('click', e => { if ($('tab-map').getAttribute('aria-selected') === 'true') setStart(e.latlng.lng, e.latlng.lat, false); });

  function setTab(gps) {
    $('tab-gps').setAttribute('aria-selected', gps); $('tab-map').setAttribute('aria-selected', !gps);
    $('gps-box').hidden = !gps; $('hint-map').hidden = gps;
  }
  $('tab-map').onclick = () => setTab(false);
  $('tab-gps').onclick = () => setTab(true);

  function numsFrom(t) {
    t = t.trim().replace(/;/g, ' ');
    const parts = /\d\.\d+\s*,\s*-?\d/.test(t) ? t.split(',') : t.split(/\s+/);
    return parts.map(s => parseFloat(s.trim().replace(',', '.'))).filter(v => !isNaN(v));
  }
  function readCoords() {
    let a = numsFrom($('lat').value), b = numsFrom($('lon').value);
    if (a.length >= 2) { b = [a[1]]; a = [a[0]]; }       // "43.1, 6.2" collé dans un seul champ
    if (a.length < 1 || b.length < 1) return null;
    const lat = a[0], lon = b[0];
    return (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) ? [lon, lat] : null;
  }
  $('btn-place').onclick = () => {
    const c = readCoords();
    if (!c) return msg('Coordonnées invalides (latitude −90…90, longitude −180…180).', 'err');
    msg(''); setStart(c[0], c[1], true);
  };
  $('btn-locate').onclick = () => {
    if (!navigator.geolocation) return msg('Géolocalisation indisponible.', 'err');
    navigator.geolocation.getCurrentPosition(
      p => { msg(''); setStart(p.coords.longitude, p.coords.latitude, true); },
      () => msg('Position refusée ou indisponible.', 'err'), { enableHighAccuracy: true, timeout: 15000 });
  };
  try { const s = JSON.parse(localStorage.getItem('routage.start')); if (s && s.length === 2) { setStart(s[0], s[1], false); map.setView([s[1], s[0]], 13); } } catch (e) { }

  /* ---------- paramètres ---------- */
  const prov = $('provider');
  Object.values(Routage.providers).forEach(p => prov.add(new Option(p.label, p.id)));
  try { prov.value = localStorage.getItem('routage.provider') || 'ign'; } catch (e) { }
  if (!prov.value) prov.value = 'ign';
  prov.addEventListener('change', () => { try { localStorage.setItem('routage.provider', prov.value); } catch (e) { } });
  $('dist').addEventListener('input', () => { $('dist-out').textContent = (+$('dist').value).toLocaleString('fr-FR') + ' km'; });
  $('dist').addEventListener('change', clearResults);

  function msg(t, cls) { const s = $('status'); s.textContent = t; s.className = 'status' + (cls ? ' ' + cls : ''); }

  /* ---------- génération ---------- */
  function clearResults() {
    lines.forEach(l => map.removeLayer(l)); lines = []; cands = []; sel = -1;
    $('results').hidden = true; $('cands').innerHTML = '';
    ['btn-gpx', 'btn-kml', 'btn-both'].forEach(i => $(i).disabled = true);
  }
  function busy(b) {
    $('btn-run').hidden = b; $('btn-cancel').hidden = !b; $('prog').hidden = !b;
    if (b) { $('prog').value = 0; }
  }
  $('btn-cancel').onclick = () => { if (abortCtl) abortCtl.abort(); };

  $('btn-run').onclick = async () => {
    if (!start) return;
    clearResults(); msg('Calcul des boucles…'); busy(true);
    abortCtl = new AbortController();
    const first = prov.value;
    const order = [Routage.providers[first]];
    if ($('fallback').checked) Object.values(Routage.providers).forEach(p => { if (p.id !== first) order.push(p); });
    const router = Routage.chain(order);
    const D = +$('dist').value * 1000;
    try {
      cands = await Routage.generateLoops({
        start, distanceM: D, router, signal: abortCtl.signal,
        onProgress: (d, n) => { $('prog').max = n; $('prog').value = d; msg('Boucle ' + d + ' / ' + n + '…'); }
      });
      cands = cands.slice(0, 6);
      draw();
      const best = Math.abs(cands[0].err);
      const used = [...new Set(cands.map(c => Routage.providers[c.provider].label.split(' (')[0]))].join(', ');
      if (best > 0.15) msg('Aucune boucle proche de la distance demandée (meilleur écart ' + Math.round(best * 100) + ' %). Essayez une autre distance ou un autre départ. Service : ' + used + '.', 'warn');
      else msg(cands.length + ' boucle(s) proposée(s) — service : ' + used + '.');
    } catch (e) {
      if (e.name === 'AbortError') msg('Calcul annulé.');
      else msg('Échec du routage : ' + e.message, 'err');
    } finally { busy(false); abortCtl = null; }
  };

  function draw() {
    const list = $('cands'); list.innerHTML = '';
    cands.forEach((c, i) => {
      const col = COLORS[i % COLORS.length];
      const pl = L.polyline(c.coords.map(p => [p[1], p[0]]), { color: col, weight: 4, opacity: .6 }).addTo(map);
      pl.on('click', () => select(i)); lines.push(pl);
      const li = document.createElement('li');
      const sign = c.err >= 0 ? '+' : '−';
      li.innerHTML = '<button type="button" aria-pressed="false"><span class="dot" style="background:' + col + '"></span><span><b>' + fmtKm(c.len) +
        ' km</b><small>écart ' + sign + Math.abs(Math.round(c.err * 100)) + ' % · vraie boucle ' + Math.round((1 - c.overlap) * 100) + ' % · ' +
        Routage.providers[c.provider].label.split(' (')[0] + '</small></span></button>';
      li.firstChild.onclick = () => select(i);
      list.appendChild(li);
    });
    $('results').hidden = false;
    map.fitBounds(L.featureGroup(lines).getBounds().pad(0.1));
    select(0);
  }

  function select(i) {
    sel = i;
    lines.forEach((l, k) => { l.setStyle({ weight: k === i ? 7 : 4, opacity: k === i ? 1 : .5 }); if (k === i) l.bringToFront(); });
    [...$('cands').children].forEach((li, k) => li.firstChild.setAttribute('aria-pressed', k === i));
    $('name').value = 'Boucle ' + fmtKm(cands[i].len).replace(',', '.') + ' km';
    ['btn-gpx', 'btn-kml', 'btn-both'].forEach(b => $(b).disabled = false);
  }

  /* ---------- export ---------- */
  function save(ext, mime) {
    if (sel < 0) return;
    const c = cands[sel], name = ($('name').value || 'Boucle').trim();
    const desc = fmtKm(c.len) + ' km — boucle calculée par routage';
    const txt = ext === 'gpx' ? Routage.toGPX(name, desc, c.coords) : Routage.toKML(name, desc, c.coords);
    const file = (name.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'boucle') + '.' + ext;
    const blob = new Blob([txt], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $('btn-gpx').onclick = () => save('gpx', 'application/gpx+xml');
  $('btn-kml').onclick = () => save('kml', 'application/vnd.google-earth.kml+xml');
  $('btn-both').onclick = () => { save('gpx', 'application/gpx+xml'); setTimeout(() => save('kml', 'application/vnd.google-earth.kml+xml'), 500); };
})();
