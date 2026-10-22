/* routage — moteur : génération de boucles, fournisseurs de routage, exports */
(function (g) {
  'use strict';
  const R = 6371008.8;
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;

  /* ---------- géométrie ([lon, lat]) ---------- */
  function hav(a, b) {
    const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function lengthOf(c) { let d = 0; for (let i = 1; i < c.length; i++) d += hav(c[i - 1], c[i]); return d; }
  function dest(p, brg, dist) {
    const d = dist / R, t = toRad(brg), f1 = toRad(p[1]), l1 = toRad(p[0]);
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return [((toDeg(l2) + 540) % 360) - 180, toDeg(f2)];
  }

  /* Points de passage répartis sur un cercle passant par le départ.
     bearing : direction départ -> centre ; n : nb de points intermédiaires ; dir : +1/-1 sens de parcours */
  function waypoints(start, bearing, n, diameter, dir) {
    const c = dest(start, bearing, diameter / 2);
    const base = (bearing + 180) % 360;
    const pts = [start];
    for (let j = 1; j <= n; j++) pts.push(dest(c, base + dir * j * 360 / (n + 1), diameter / 2));
    pts.push(start);
    return pts;
  }

  /* Part du tracé déjà parcourue (aller-retour sur le même chemin), 0..1 */
  function overlapRatio(coords) {
    const step = 25, cell = 30;
    const s = [];
    let acc = 0, next = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = hav(coords[i - 1], coords[i]);
      while (next <= acc + seg) {
        const t = seg ? (next - acc) / seg : 0;
        s.push([coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t]);
        next += step;
      }
      acc += seg;
    }
    if (s.length < 10) return 0;
    const lat0 = s[0][1], kx = R * Math.cos(toRad(lat0)) * Math.PI / 180, ky = R * Math.PI / 180;
    const grid = new Map();
    let dup = 0;
    const far = 12; // ~300 m de tracé entre deux passages = vrai recoupement
    s.forEach((p, i) => {
      const cx = Math.floor(p[0] * kx / cell), cy = Math.floor(p[1] * ky / cell);
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) {
        const l = grid.get((cx + dx) + ',' + (cy + dy));
        if (l && l.some(j => i - j > far && (s.length - i) + j > far)) hit = true;
      }
      if (hit) dup++;
      const k = cx + ',' + cy;
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    return dup / s.length;
  }

  /* ---------- réseau ---------- */
  async function fetchJson(url, opts, signal, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 25000);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      if (!r.ok) {
        let m = ''; try { m = (await r.text()).slice(0, 120); } catch (e) { }
        throw new Error('HTTP ' + r.status + (m ? ' — ' + m : ''));
      }
      return await r.json();
    } catch (e) {
      if (signal && signal.aborted) { const a = new Error('annulé'); a.name = 'AbortError'; throw a; }
      if (ctrl.signal.aborted) throw new Error('délai dépassé');
      throw e;
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function decodePoly(str, prec) {
    const f = Math.pow(10, prec); let i = 0, lat = 0, lon = 0; const out = [];
    while (i < str.length) {
      let b, s = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lat += (r & 1) ? ~(r >> 1) : (r >> 1);
      s = 0; r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lon += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push([lon / f, lat / f]);
    }
    return out;
  }

  const ll = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);

  /* Chaque fournisseur : route(points[[lon,lat]...], signal) -> { coords } */
  const providers = {
    ign: {
      id: 'ign', label: 'IGN (BD TOPO, piéton)',
      async route(pts, signal) {
        const u = 'https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=pedestrian&optimization=shortest'
          + '&start=' + ll(pts[0]) + '&end=' + ll(pts[pts.length - 1])
          + (pts.length > 2 ? '&intermediates=' + pts.slice(1, -1).map(ll).join('|') : '')
          + '&geometryFormat=geojson&getSteps=false';
        const j = await fetchJson(u, {}, signal);
        const c = j && j.geometry && j.geometry.coordinates;
        if (!c || c.length < 2) throw new Error('réponse IGN sans géométrie');
        return { coords: c };
      }
    },
    valhalla: {
      id: 'valhalla', label: 'Valhalla (OSM, sentiers privilégiés)',
      async route(pts, signal) {
        const body = {
          locations: pts.map((p, i) => ({ lon: p[0], lat: p[1], type: (i === 0 || i === pts.length - 1) ? 'break' : 'through' })),
          costing: 'pedestrian',
          costing_options: { pedestrian: { use_trails: 1.0, use_tracks: 1.0, use_living_streets: 0.0, walkway_factor: 1.0 } },
          directions_options: { units: 'km' }
        };
        const j = await fetchJson('https://valhalla1.openstreetmap.de/route',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
        if (!j.trip || !j.trip.legs) throw new Error('réponse Valhalla invalide');
        let coords = [];
        j.trip.legs.forEach((leg, i) => {
          const d = decodePoly(leg.shape, 6);
          coords = coords.concat(i ? d.slice(1) : d);
        });
        return { coords };
      }
    },
    brouter: {
      id: 'brouter', label: 'BRouter (OSM, profil randonnée)',
      async route(pts, signal) {
        const u = 'https://brouter.de/brouter?lonlats=' + pts.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('|')
          + '&profile=hiking-mountain&alternativeidx=0&format=geojson';
        const j = await fetchJson(u, {}, signal, 40000);
        const f = j && j.features && j.features[0];
        if (!f) throw new Error('réponse BRouter invalide');
        return { coords: f.geometry.coordinates };
      }
    },
    osrm: {
      id: 'osrm', label: 'OSRM piéton (OSM)',
      async route(pts, signal) {
        const u = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/' + pts.map(ll).join(';')
          + '?overview=full&geometries=geojson&continue_straight=false';
        const j = await fetchJson(u, {}, signal);
        if (!j.routes || !j.routes[0]) throw new Error('OSRM : ' + (j.code || 'pas de route'));
        return { coords: j.routes[0].geometry.coordinates };
      }
    }
  };

  /* Essaie les fournisseurs dans l'ordre ; un fournisseur en échec est écarté pour la suite */
  function chain(list) {
    const failed = new Set();
    return {
      lastError: null,
      async route(pts, signal) {
        let err = null;
        for (const p of list) {
          if (failed.has(p.id)) continue;
          try { const r = await p.route(pts, signal); r.provider = p.id; return r; }
          catch (e) {
            if (e.name === 'AbortError') throw e;
            err = new Error(p.label.split(' (')[0] + ' : ' + e.message);
            this.lastError = err; failed.add(p.id);
          }
        }
        throw err || new Error('aucun service de routage disponible');
      }
    };
  }

  /* ---------- génération de boucles ---------- */
  async function buildCandidate(router, start, D, bearing, n, dir, signal) {
    let diam = D / 1.35 / Math.PI;   // 1,35 : détour moyen d'un itinéraire piéton
    let best = null;
    for (let it = 0; it < 4; it++) {
      const pts = waypoints(start, bearing, n, diam, dir);
      const res = await router.route(pts, signal);
      const len = lengthOf(res.coords);
      const err = (len - D) / D;
      if (!best || Math.abs(err) < Math.abs(best.err)) best = { coords: res.coords, len, err, provider: res.provider, bearing, n };
      if (Math.abs(err) <= 0.04) break;
      diam *= Math.min(1.8, Math.max(0.55, D / len));
    }
    return best;
  }

  async function generateLoops(o) {
    const D = o.distanceM, count = o.count || 6, start = o.start;
    const off = Math.random() * 360 / count;
    const jobs = [];
    for (let i = 0; i < count; i++) jobs.push({ bearing: (off + i * 360 / count) % 360, n: i % 2 ? 3 : 2, dir: i % 3 === 0 ? 1 : -1 });
    const results = [], errors = [];
    let done = 0, next = 0;
    async function worker() {
      while (next < jobs.length) {
        const j = jobs[next++];
        try { results.push(await buildCandidate(o.router, start, D, j.bearing, j.n, j.dir, o.signal)); }
        catch (e) { if (e.name === 'AbortError') throw e; errors.push(e); }
        done++; if (o.onProgress) o.onProgress(done, jobs.length);
      }
    }
    await Promise.all([worker(), worker()]);
    if (!results.length) throw (o.router.lastError || errors[0] || new Error('aucune boucle trouvée'));
    const seen = new Set(), out = [];
    results.forEach(r => {
      const c = r.coords, k = [0.25, 0.5, 0.75].map(f => c[Math.floor(c.length * f)].map(v => v.toFixed(4)).join(',')).join('|');
      if (seen.has(k)) return; seen.add(k);
      r.overlap = overlapRatio(r.coords);
      r.score = Math.abs(r.err) + 0.5 * r.overlap;
      out.push(r);
    });
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  /* ---------- exports ---------- */
  const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

  function toGPX(name, desc, coords) {
    const pt = (c, tag) => '<' + tag + ' lat="' + c[1].toFixed(6) + '" lon="' + c[0].toFixed(6) + '"'
      + (c.length > 2 && isFinite(c[2]) ? '><ele>' + (+c[2]).toFixed(1) + '</ele></' + tag + '>' : '/>');
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<gpx version="1.1" creator="routage" xmlns="http://www.topografix.com/GPX/1/1">\n'
      + '<metadata><name>' + esc(name) + '</name><desc>' + esc(desc) + '</desc><time>' + new Date().toISOString() + '</time></metadata>\n'
      + '<wpt lat="' + coords[0][1].toFixed(6) + '" lon="' + coords[0][0].toFixed(6) + '"><name>Départ</name></wpt>\n'
      + '<trk><name>' + esc(name) + '</name><trkseg>\n' + coords.map(c => pt(c, 'trkpt')).join('\n') + '\n</trkseg></trk>\n</gpx>\n';
  }

  function toKML(name, desc, coords) {
    const co = coords.map(c => c[0].toFixed(6) + ',' + c[1].toFixed(6) + ',' + (c.length > 2 && isFinite(c[2]) ? (+c[2]).toFixed(1) : 0)).join(' ');
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + esc(name) + '</name>\n'
      + '<Style id="t"><LineStyle><color>ff2e57e4</color><width>4</width></LineStyle></Style>\n'
      + '<Placemark><name>Départ</name><Point><coordinates>' + coords[0][0].toFixed(6) + ',' + coords[0][1].toFixed(6) + ',0</coordinates></Point></Placemark>\n'
      + '<Placemark><name>' + esc(name) + '</name><description>' + esc(desc) + '</description><styleUrl>#t</styleUrl>'
      + '<LineString><tessellate>1</tessellate><coordinates>' + co + '</coordinates></LineString></Placemark>\n'
      + '</Document></kml>\n';
  }

  const api = { providers, chain, generateLoops, lengthOf, overlapRatio, waypoints, dest, hav, toGPX, toKML, decodePoly };
  g.Routage = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
