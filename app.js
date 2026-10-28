(function () {
  'use strict';

  var SAVE_INTERVAL_MS = 5000;
  var STALE_MS = 6000;
  var params = new URLSearchParams(location.search);
  var demo = params.get('demo') === '1';

  var state = Core.loadState(localStorage);
  var prevFix = null;
  var speedMps = null;
  var lastFixAt = 0;
  var tracking = false;
  var dirty = false;
  var watchId = null;
  var demoTimer = null;
  var wakeLock = null;
  var statusKind = '';
  var statusText = '';

  var el = {
    speed: document.getElementById('speed'),
    status: document.getElementById('status'),
    odo: document.getElementById('odo'),
    gpsBtn: document.getElementById('gps-btn'),
    tripList: document.getElementById('trip-list'),
    noTrips: document.getElementById('no-trips'),
    newTrip: document.getElementById('new-trip'),
    tripName: document.getElementById('trip-name'),
    odoForm: document.getElementById('odo-form'),
    odoInput: document.getElementById('odo-input'),
    backup: document.getElementById('backup'),
    backupMake: document.getElementById('backup-make'),
    backupRestore: document.getElementById('backup-restore'),
    dataMsg: document.getElementById('data-msg'),
    diagVerdict: document.getElementById('diag-verdict'),
    diagBody: document.getElementById('diag-body'),
    diagReset: document.getElementById('diag-reset')
  };
  var tripRefs = {};
  var diag = Core.diagInit();
  var permission = 'desconocido';

  function setStatus(text, kind) {
    statusText = text;
    statusKind = kind || '';
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function save() {
    if (Core.saveState(localStorage, state)) {
      dirty = false;
    } else {
      setStatus('No se pudo guardar en este navegador', 'error');
    }
  }

  function markDirty() {
    dirty = true;
  }

  function renderSpeed() {
    var fresh = tracking && speedMps !== null && Date.now() - lastFixAt <= STALE_MS;
    el.speed.textContent = fresh ? String(Math.round(speedMps * 3.6)) : '--';
    el.odo.textContent = Core.formatKm(state.odometerM);
  }

  function makeButton(label, className, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (className) {
      b.className = className;
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTrips() {
    el.tripList.textContent = '';
    tripRefs = {};
    el.noTrips.hidden = state.trips.length > 0;
    state.trips.forEach(function (trip) {
      var li = document.createElement('li');
      li.className = 'trip';
      var head = document.createElement('div');
      head.className = 'trip-head';
      var name = document.createElement('span');
      name.className = 'trip-name';
      name.textContent = trip.name;
      var dist = document.createElement('span');
      dist.className = 'trip-dist';
      head.appendChild(name);
      head.appendChild(dist);
      var stats = document.createElement('div');
      stats.className = 'trip-stats';
      var actions = document.createElement('div');
      actions.className = 'trip-actions';
      var toggle = makeButton('', '', function () {
        trip.active = !trip.active;
        markDirty();
        updateTrip(trip);
      });
      var reset = makeButton('Reiniciar', '', function () {
        if (confirm('¿Reiniciar “' + trip.name + '”?')) {
          Core.resetTrip(trip);
          markDirty();
          updateTrip(trip);
        }
      });
      var remove = makeButton('Borrar', 'danger', function () {
        if (confirm('¿Borrar “' + trip.name + '”?')) {
          Core.removeTrip(state, trip.id);
          markDirty();
          renderTrips();
          save();
        }
      });
      actions.appendChild(toggle);
      actions.appendChild(reset);
      actions.appendChild(remove);
      li.appendChild(head);
      li.appendChild(stats);
      li.appendChild(actions);
      el.tripList.appendChild(li);
      tripRefs[trip.id] = { li: li, dist: dist, stats: stats, toggle: toggle };
      updateTrip(trip);
    });
  }

  function updateTrip(trip) {
    var ref = tripRefs[trip.id];
    if (!ref) {
      return;
    }
    ref.li.className = 'trip' + (trip.active ? ' running' : '');
    ref.dist.textContent = Core.formatKm(trip.distanceM) + ' km';
    ref.stats.textContent = '';
    [
      'Tiempo ' + Core.formatDuration(trip.elapsedMs),
      'Prom. ' + Math.round(Core.avgKmh(trip)) + ' km/h',
      'Máx. ' + Math.round(trip.maxMps * 3.6) + ' km/h'
    ].forEach(function (text) {
      var s = document.createElement('span');
      s.textContent = text;
      ref.stats.appendChild(s);
    });
    ref.toggle.textContent = trip.active ? 'Pausar' : 'Reanudar';
  }

  function updateAllTrips() {
    state.trips.forEach(updateTrip);
  }

  function renderDiag() {
    var tab = document.getElementById('tab-diag');
    if (tab.hidden) {
      return;
    }
    var now = Date.now();
    var v = Core.diagVerdict(diag, now);
    el.diagVerdict.textContent = v.text;
    el.diagVerdict.className = 'verdict ' + v.level;
    var f = diag.last;
    function kmh(mps) { return mps === null || !isFinite(mps) ? '—' : (mps * 3.6).toFixed(1) + ' km/h'; }
    var rows = [
      ['Permiso de ubicación', permission],
      ['Lecturas recibidas', String(diag.total)],
      ['Con velocidad directa', diag.total ? diag.withSpeed + ' de ' + diag.total : '—'],
      ['Velocidad directa (coords.speed)', f ? kmh(f.speed) : '—'],
      ['Velocidad por posición', kmh(diag.derivedMps)],
      ['Precisión actual', f && isFinite(f.acc) ? '±' + f.acc.toFixed(0) + ' m' : '—'],
      ['Precisión mejor / peor', diag.minAcc === null ? '—' : diag.minAcc.toFixed(0) + ' / ' + diag.maxAcc.toFixed(0) + ' m'],
      ['Frecuencia', diag.total > 1 ? Core.diagRateHz(diag).toFixed(2) + ' Hz' : '—'],
      ['Edad de la lectura', f ? ((now - f.t) / 1000).toFixed(1) + ' s' : '—'],
      ['Sin lecturas nuevas hace', diag.lastAt ? ((now - diag.lastAt) / 1000).toFixed(1) + ' s' : '—'],
      ['Lecturas repetidas', String(diag.duplicates)],
      ['Rumbo', f && f.heading !== null && isFinite(f.heading) ? f.heading.toFixed(0) + '°' : '—'],
      ['Altitud', f && f.alt !== null && isFinite(f.alt) ? f.alt.toFixed(0) + ' m' : '—'],
      ['Errores', diag.errors ? diag.errors + ' (' + diag.lastError + ')' : '0'],
      ['Contexto seguro (HTTPS)', window.isSecureContext ? 'sí' : 'no']
    ];
    el.diagBody.textContent = '';
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      el.diagBody.appendChild(tr);
    });
  }

  function onFix(fix) {
    Core.diagRecord(diag, fix, Date.now());
    var r = Core.processFix(prevFix, fix);
    prevFix = r.prev;
    if (r.status === 'inaccurate') {
      setStatus('Señal GPS débil (±' + Math.round(fix.acc) + ' m)', '');
      return;
    }
    if (r.speedMps === null) {
      return;
    }
    speedMps = r.speedMps;
    lastFixAt = Date.now();
    if (r.dtMs > 0) {
      Core.applyMovement(state, r.deltaM, r.speedMps, r.dtMs);
      markDirty();
      updateAllTrips();
    }
    setStatus('GPS activo' + (isFinite(fix.acc) ? ' (±' + Math.round(fix.acc) + ' m)' : ''), 'ok');
    renderSpeed();
  }

  function onPosition(pos) {
    var c = pos.coords;
    onFix({
      t: pos.timestamp,
      lat: c.latitude,
      lon: c.longitude,
      acc: c.accuracy,
      speed: c.speed,
      heading: c.heading,
      alt: c.altitude
    });
  }

  function onGeoError(err) {
    Core.diagRecordError(diag, err.code, err.message);
    if (err.code === 1) {
      setStatus('Permiso de ubicación denegado. Actívalo en Chrome para este sitio.', 'error');
      stopTracking();
    } else if (err.code === 2) {
      setStatus('Ubicación no disponible. Buscando señal…', 'error');
    } else {
      setStatus('Sin respuesta del GPS. Reintentando…', 'error');
    }
  }

  function startDemo() {
    var t = Date.now();
    var lat = 4.711;
    var lon = -74.0721;
    var step = 0;
    demoTimer = setInterval(function () {
      step += 1;
      var speed = Math.max(0, 14 + 12 * Math.sin(step / 12));
      t += 1000;
      lat += (speed * Math.cos(0.6)) / 111320;
      lon += (speed * Math.sin(0.6)) / (111320 * Math.cos(lat * Math.PI / 180));
      onFix({ t: t, lat: lat, lon: lon, acc: 5, speed: speed });
    }, 1000);
  }

  function requestWakeLock() {
    if (!navigator.wakeLock) {
      return;
    }
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }, function () {});
  }

  function startTracking() {
    if (tracking) {
      return;
    }
    if (!demo && !navigator.geolocation) {
      setStatus('Este navegador no ofrece geolocalización', 'error');
      return;
    }
    tracking = true;
    prevFix = null;
    el.gpsBtn.textContent = 'Detener GPS';
    el.gpsBtn.className = '';
    setStatus(demo ? 'Modo demostración' : 'Buscando señal GPS…', '');
    if (demo) {
      startDemo();
    } else {
      watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      });
    }
    requestWakeLock();
  }

  function stopTracking() {
    tracking = false;
    prevFix = null;
    speedMps = null;
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (demoTimer !== null) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
    el.gpsBtn.textContent = 'Iniciar GPS';
    el.gpsBtn.className = 'primary';
    if (statusKind !== 'error') {
      setStatus('GPS detenido', '');
    }
    save();
    renderSpeed();
  }

  el.gpsBtn.addEventListener('click', function () {
    if (tracking) {
      stopTracking();
    } else {
      startTracking();
    }
  });

  el.newTrip.addEventListener('submit', function (e) {
    e.preventDefault();
    var trip = Core.createTrip(state, el.tripName.value, Date.now());
    if (!trip) {
      setStatus('Límite de viajes alcanzado. Borra alguno.', 'error');
      return;
    }
    el.tripName.value = '';
    renderTrips();
    save();
  });

  el.odoForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (el.odoInput.value !== '' && Core.setOdometerKm(state, el.odoInput.value)) {
      el.odoInput.value = '';
      el.dataMsg.textContent = 'Odómetro actualizado.';
      save();
      renderSpeed();
    } else {
      el.dataMsg.textContent = 'Valor de odómetro no válido.';
    }
  });

  el.backupMake.addEventListener('click', function () {
    el.backup.value = Core.exportState(state);
    el.backup.select();
    el.dataMsg.textContent = 'Copia este texto y guárdalo en un lugar seguro.';
  });

  el.backupRestore.addEventListener('click', function () {
    var restored = Core.importState(el.backup.value);
    if (!restored) {
      el.dataMsg.textContent = 'El respaldo no es válido.';
      return;
    }
    if (!confirm('Esto reemplazará el odómetro y los viajes actuales. ¿Continuar?')) {
      return;
    }
    state = restored;
    renderTrips();
    renderSpeed();
    save();
    el.dataMsg.textContent = 'Respaldo restaurado.';
  });

  el.diagReset.addEventListener('click', function () {
    diag = Core.diagInit();
    renderDiag();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        document.getElementById('tab-' + t.getAttribute('data-tab')).hidden = !on;
      });
      renderDiag();
    });
  });

  setInterval(function () {
    renderSpeed();
    renderDiag();
    if (dirty) {
      save();
    }
  }, 1000);

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
      var names = { granted: 'concedido', denied: 'denegado', prompt: 'por preguntar' };
      var update = function () { permission = names[p.state] || p.state; };
      update();
      p.onchange = update;
    }, function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      save();
    } else if (tracking) {
      requestWakeLock();
    }
  });
  window.addEventListener('pagehide', save);

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  if (demo) {
    setStatus('Modo demostración: toca “Iniciar GPS”', '');
  }
  renderTrips();
  renderSpeed();
})();
