(function (root) {
  'use strict';

  var EARTH_M = 6371008.8;
  var STORAGE_KEY = 'xfider.speedtrip.v1';
  var MAX_TRIPS = 100;
  var DEFAULTS = {
    maxAccuracyM: 40,
    maxGapMs: 30000,
    maxSpeedMps: 70,
    minMovingMps: 0.5
  };

  function haversine(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function result(prev, speedMps, deltaM, dtMs, status) {
    return { prev: prev, speedMps: speedMps, deltaM: deltaM, dtMs: dtMs, status: status };
  }

  function processFix(prev, fix, opts) {
    var o = Object.assign({}, DEFAULTS, opts);
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lon) || !isFinite(fix.t)) {
      return result(prev, null, 0, 0, 'invalid');
    }
    var reported = fix.speed !== null && isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    if (isFinite(fix.acc) && fix.acc > o.maxAccuracyM) {
      return result(prev, null, 0, 0, 'inaccurate');
    }
    if (!prev) {
      return result(fix, reported === null ? 0 : reported, 0, 0, 'first');
    }
    var dtMs = fix.t - prev.t;
    if (dtMs <= 0) {
      return result(prev, null, 0, 0, 'stale');
    }
    if (dtMs > o.maxGapMs) {
      return result(fix, reported === null ? 0 : reported, 0, 0, 'gap');
    }
    var d = haversine(prev, fix);
    var implied = d / (dtMs / 1000);
    if (implied > o.maxSpeedMps) {
      return result(prev, null, 0, 0, 'jump');
    }
    var speed = reported === null ? implied : reported;
    if (speed < o.minMovingMps) {
      return result(fix, 0, 0, dtMs, 'stationary');
    }
    return result(fix, speed, d, dtMs, 'ok');
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function emptyState() {
    return { version: 1, odometerM: 0, trips: [] };
  }

  function createTrip(state, name, now) {
    if (state.trips.length >= MAX_TRIPS) {
      return null;
    }
    var trip = {
      id: newId(),
      name: String(name || '').trim().slice(0, 40) || 'Viaje ' + (state.trips.length + 1),
      distanceM: 0,
      elapsedMs: 0,
      movingMs: 0,
      maxMps: 0,
      active: true,
      createdAt: now
    };
    state.trips.unshift(trip);
    return trip;
  }

  function removeTrip(state, id) {
    state.trips = state.trips.filter(function (t) { return t.id !== id; });
  }

  function resetTrip(trip) {
    trip.distanceM = 0;
    trip.elapsedMs = 0;
    trip.movingMs = 0;
    trip.maxMps = 0;
  }

  function setOdometerKm(state, km) {
    var value = Number(km);
    if (!isFinite(value) || value < 0 || value > 9999999) {
      return false;
    }
    state.odometerM = value * 1000;
    return true;
  }

  function applyMovement(state, deltaM, speedMps, dtMs, minMovingMps) {
    var min = minMovingMps === undefined ? DEFAULTS.minMovingMps : minMovingMps;
    state.odometerM += deltaM;
    state.trips.forEach(function (trip) {
      if (!trip.active) {
        return;
      }
      trip.distanceM += deltaM;
      trip.elapsedMs += dtMs;
      if (speedMps >= min) {
        trip.movingMs += dtMs;
      }
      if (speedMps > trip.maxMps) {
        trip.maxMps = speedMps;
      }
    });
  }

  function avgKmh(trip) {
    return trip.movingMs > 0 ? (trip.distanceM / (trip.movingMs / 1000)) * 3.6 : 0;
  }

  function formatKm(m) {
    return (m / 1000).toFixed(1);
  }

  function formatDuration(ms) {
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h + ':' + (m < 10 ? '0' : '') + m;
  }

  function num(value, max) {
    var n = Number(value);
    return isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
  }

  function sanitize(raw) {
    var state = emptyState();
    if (!raw || typeof raw !== 'object') {
      return state;
    }
    state.odometerM = num(raw.odometerM, 1e10);
    if (Array.isArray(raw.trips)) {
      raw.trips.slice(0, MAX_TRIPS).forEach(function (t) {
        if (!t || typeof t !== 'object') {
          return;
        }
        state.trips.push({
          id: typeof t.id === 'string' && t.id ? t.id.slice(0, 40) : newId(),
          name: String(t.name || '').slice(0, 40) || 'Viaje',
          distanceM: num(t.distanceM, 1e10),
          elapsedMs: num(t.elapsedMs, 1e12),
          movingMs: num(t.movingMs, 1e12),
          maxMps: num(t.maxMps, 200),
          active: t.active === true,
          createdAt: num(t.createdAt, 1e15)
        });
      });
    }
    return state;
  }

  function loadState(storage) {
    try {
      var text = storage.getItem(STORAGE_KEY);
      return text ? sanitize(JSON.parse(text)) : emptyState();
    } catch (e) {
      return emptyState();
    }
  }

  function saveState(storage, state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  function exportState(state) {
    return JSON.stringify(state);
  }

  function importState(text) {
    try {
      var raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.trips)) {
        return null;
      }
      return sanitize(raw);
    } catch (e) {
      return null;
    }
  }

  var DIAG_WINDOW = 20;

  function diagInit() {
    return {
      total: 0, withSpeed: 0, errors: 0, duplicates: 0,
      arrivals: [], last: null, prev: null, derivedMps: null,
      minAcc: null, maxAcc: null, lastError: ''
    };
  }

  function diagRecord(d, fix, nowMs) {
    d.total += 1;
    if (fix.speed !== null && isFinite(fix.speed)) {
      d.withSpeed += 1;
    }
    if (d.last && d.last.t === fix.t) {
      d.duplicates += 1;
    }
    if (isFinite(fix.acc)) {
      d.minAcc = d.minAcc === null ? fix.acc : Math.min(d.minAcc, fix.acc);
      d.maxAcc = d.maxAcc === null ? fix.acc : Math.max(d.maxAcc, fix.acc);
    }
    d.arrivals.push(nowMs);
    if (d.arrivals.length > DIAG_WINDOW) {
      d.arrivals.shift();
    }
    d.derivedMps = null;
    if (d.last && fix.t > d.last.t && isFinite(fix.lat) && isFinite(fix.lon)) {
      d.derivedMps = haversine(d.last, fix) / ((fix.t - d.last.t) / 1000);
    }
    if (!d.last || fix.t !== d.last.t) {
      d.prev = d.last;
    }
    d.last = fix;
    d.lastAt = nowMs;
  }

  function diagRecordError(d, code, message) {
    d.errors += 1;
    d.lastError = code + (message ? ': ' + message : '');
  }

  function diagRateHz(d) {
    var a = d.arrivals;
    if (a.length < 2 || a[a.length - 1] <= a[0]) {
      return 0;
    }
    return (a.length - 1) / ((a[a.length - 1] - a[0]) / 1000);
  }

  function diagVerdict(d, nowMs) {
    if (d.total === 0) {
      return { level: 'warn', text: 'Sin lecturas todavía' };
    }
    var notes = [];
    var level = 'ok';
    if (d.withSpeed === 0 && d.total >= 3) {
      level = 'warn';
      notes.push('La unidad no entrega velocidad directa; se calcula por posición');
    }
    if (d.duplicates > d.total / 2 && d.total >= 4) {
      level = 'bad';
      notes.push('Muchas lecturas repetidas: ubicación congelada o simulada');
    }
    if (d.maxAcc !== null && d.maxAcc > DEFAULTS.maxAccuracyM) {
      if (level === 'ok') { level = 'warn'; }
      notes.push('Precisión peor de ' + DEFAULTS.maxAccuracyM + ' m en algunas lecturas');
    }
    if (d.lastAt && nowMs - d.lastAt > 6000) {
      level = 'bad';
      notes.push('Sin lecturas nuevas hace más de 6 s');
    }
    return { level: level, text: notes.length ? notes.join('. ') : 'GPS entrega velocidad y precisión útiles' };
  }

  var Core = {
    diagInit: diagInit,
    diagRecord: diagRecord,
    diagRecordError: diagRecordError,
    diagRateHz: diagRateHz,
    diagVerdict: diagVerdict,
    haversine: haversine,
    processFix: processFix,
    emptyState: emptyState,
    createTrip: createTrip,
    removeTrip: removeTrip,
    resetTrip: resetTrip,
    setOdometerKm: setOdometerKm,
    applyMovement: applyMovement,
    avgKmh: avgKmh,
    formatKm: formatKm,
    formatDuration: formatDuration,
    sanitize: sanitize,
    loadState: loadState,
    saveState: saveState,
    exportState: exportState,
    importState: importState,
    DEFAULTS: DEFAULTS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  } else {
    root.Core = Core;
  }
})(typeof self !== 'undefined' ? self : this);
