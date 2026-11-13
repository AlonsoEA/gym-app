import * as cloud from './sync.js';

const MODE_KEY = 'gymapp.mode'; // 'local' si el usuario elige usar la app sin cuenta

/* =========================================================
   Gym — registro de entrenamientos
   Todos los datos se guardan en el propio dispositivo (localStorage).
   ========================================================= */

const STORE_KEY = 'gymapp.data.v1';
const DEFAULT_GROUPS = ['Pecho', 'Espalda', 'Bíceps', 'Tríceps', 'Hombro', 'Abdomen', 'Pierna'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- Datos ---------------- */

function freshData() {
  return {
    version: 1,
    groups: DEFAULT_GROUPS.map((name) => ({ id: uid(), name })),
    exercises: [],          // { id, groupId, name, archived }
    workouts: {},           // 'YYYY-MM-DD' -> { groups: [groupId], entries: [{ id, exerciseId, sets: [{ w, r, done }] }] }
    settings: { defaultSets: 4, weightStep: 2.5, restEnabled: true, restSeconds: 90 },
  };
}

function normalize(d) {
  const f = freshData();
  if (!d || typeof d !== 'object') return f;
  d.groups = Array.isArray(d.groups) && d.groups.length ? d.groups : f.groups;
  d.exercises = Array.isArray(d.exercises) ? d.exercises : [];
  d.workouts = d.workouts && typeof d.workouts === 'object' ? d.workouts : {};
  d.settings = Object.assign({}, f.settings, d.settings || {});
  // Antes "0 segundos" significaba desactivado: ahora es el interruptor.
  if (!d.settings.restSeconds) { d.settings.restEnabled = false; d.settings.restSeconds = 90; }
  d.version = 1;
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return freshData();
}

let data = load();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch (e) { toast('No se ha podido guardar'); }
  cloud.queuePush();
}

const hasOwnContent = (d) => d.exercises.length > 0 || Object.keys(d.workouts).length > 0;

// Añade los datos de este dispositivo a los de la cuenta, emparejando grupos y ejercicios por nombre.
function mergeLocalInto(base, local) {
  const norm = (s) => s.trim().toLowerCase();
  const gMap = {};
  for (const g of local.groups) {
    let t = base.groups.find((x) => norm(x.name) === norm(g.name));
    if (!t) { t = { id: g.id, name: g.name }; base.groups.push(t); }
    gMap[g.id] = t.id;
  }
  const eMap = {};
  for (const e of local.exercises) {
    const groupId = gMap[e.groupId] || e.groupId;
    let t = base.exercises.find((x) => x.groupId === groupId && norm(x.name) === norm(e.name));
    if (!t) { t = { ...e, groupId }; base.exercises.push(t); }
    eMap[e.id] = t.id;
  }
  for (const [k, w] of Object.entries(local.workouts)) {
    const entries = w.entries.map((en) => ({ ...en, exerciseId: eMap[en.exerciseId] || en.exerciseId }));
    const groups = w.groups.map((g) => gMap[g] || g);
    const target = base.workouts[k];
    if (!target) { base.workouts[k] = { groups, entries }; continue; }
    target.groups = [...new Set([...target.groups, ...groups])];
    for (const en of entries) if (!target.entries.some((x) => x.exerciseId === en.exerciseId)) target.entries.push(en);
  }
  return base;
}

/* ---------------- Fechas ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());

function longDate(k) {
  const d = dateOf(k);
  const year = d.getFullYear() !== new Date().getFullYear() ? ` de ${d.getFullYear()}` : '';
  return `${cap(DAYS[d.getDay()])}, ${d.getDate()} de ${MONTHS[d.getMonth()]}${year}`;
}
function shortDate(k) {
  const d = dateOf(k);
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${year}`;
}
function relDay(k) {
  const diff = Math.round((dateOf(todayKey()) - dateOf(k)) / 86400000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'ayer';
  if (diff > 1 && diff < 7) return `hace ${diff} días`;
  return shortDate(k);
}

/* ---------------- Consultas ---------------- */

const groupById = (id) => data.groups.find((g) => g.id === id);
const exById = (id) => data.exercises.find((e) => e.id === id);
const groupOrder = (id) => { const i = data.groups.findIndex((g) => g.id === id); return i < 0 ? 999 : i; };
const sortGroups = (ids) => [...new Set(ids)].filter(groupById).sort((a, b) => groupOrder(a) - groupOrder(b));
const groupNames = (ids) => sortGroups(ids).map((id) => groupById(id).name).join(' + ');

function exercisesOf(groupId, includeArchived = false) {
  return data.exercises
    .filter((e) => e.groupId === groupId && (includeArchived || !e.archived))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function hasData(s) { return s.w !== '' || s.r !== ''; }

function lastTime(exerciseId, beforeKey) {
  const keys = Object.keys(data.workouts).filter((k) => k < beforeKey).sort().reverse();
  for (const k of keys) {
    const e = data.workouts[k].entries.find((x) => x.exerciseId === exerciseId);
    if (e && e.sets.some(hasData)) return { date: k, sets: e.sets };
  }
  return null;
}

function isUsed(exerciseId) {
  return Object.values(data.workouts).some((w) => w.entries.some((e) => e.exerciseId === exerciseId));
}

function workoutGroups(w) {
  return sortGroups([...w.groups, ...w.entries.map((e) => exById(e.exerciseId)?.groupId).filter(Boolean)]);
}

function topCombos(limit = 4) {
  const counts = {};
  for (const k of Object.keys(data.workouts)) {
    const ids = sortGroups(data.workouts[k].groups);
    if (!ids.length) continue;
    const key = ids.join('|');
    counts[key] = counts[key] || { ids, n: 0, last: k };
    counts[key].n++;
    if (k > counts[key].last) counts[key].last = k;
  }
  return Object.values(counts).sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).slice(0, limit);
}

/* ---------------- Formato ---------------- */

const fmtNum = (v) => (v === '' || v == null ? '—' : String(v).replace('.', ','));
const fmtSets = (sets) => sets.filter(hasData).map((s) => `${fmtNum(s.w)}×${fmtNum(s.r)}`).join(' · ');
function parseNum(str) {
  const t = String(str).replace(',', '.').trim();
  if (t === '') return '';
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : '';
}

/* ---------------- Mutaciones ---------------- */

function ensureWorkout(k) { return (data.workouts[k] ||= { groups: [], entries: [] }); }
function cleanupWorkout(k) {
  const w = data.workouts[k];
  if (w && !w.groups.length && !w.entries.length) delete data.workouts[k];
}

function addEntry(k, exerciseId) {
  const w = ensureWorkout(k);
  const prev = lastTime(exerciseId, k);
  const sets = [];
  for (let i = 0; i < data.settings.defaultSets; i++) {
    const p = prev ? prev.sets[i] || prev.sets[prev.sets.length - 1] : null;
    sets.push({ w: p ? p.w : '', r: p ? p.r : '', done: false });
  }
  w.entries.push({ id: uid(), exerciseId, sets });
  const g = exById(exerciseId)?.groupId;
  if (g && !w.groups.includes(g)) w.groups.push(g);
  save();
}

function createExercise(groupId, name) {
  name = name.trim();
  if (!name) return null;
  const existing = data.exercises.find((e) => e.groupId === groupId && e.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.archived) { existing.archived = false; save(); return existing; }
    toast('Ya existe un ejercicio con ese nombre');
    return null;
  }
  const ex = { id: uid(), groupId, name, archived: false };
  data.exercises.push(ex);
  save();
  return ex;
}

/* ---------------- Estado de la interfaz ---------------- */

const ui = {
  tab: 'today',
  dayKey: null,                 // día abierto desde el calendario
  calMonth: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  calSel: todayKey(),
  pending: new Set(),           // grupos marcados antes de empezar
  pendingFor: null,
};

/* ---------------- Render ---------------- */

function render() {
  const y = window.scrollY;
  let html = '';
  const localMode = localStorage.getItem(MODE_KEY) === 'local';
  const needLogin = cloud.cloudEnabled && ui.authReady && !ui.user && !localMode;
  const waiting = ui.syncing || (cloud.cloudEnabled && !ui.authReady && !data.owner && !localMode);
  $('#tabbar').hidden = needLogin || waiting;
  if (waiting) html = `<div class="header"><div class="eyebrow">Gym</div><h1>Cargando tus datos…</h1></div>`;
  else if (needLogin) html = renderLogin();
  else if (ui.tab === 'today') html = renderWorkout(todayKey(), false);
  else if (ui.tab === 'calendar') html = ui.dayKey ? renderWorkout(ui.dayKey, true) : renderCalendar();
  else if (ui.tab === 'exercises') html = renderExercises();
  else if (ui.tab === 'settings') html = renderSettings();
  $('#view').innerHTML = html;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  window.scrollTo(0, y);
}

function go(tab) {
  ui.tab = tab;
  ui.dayKey = null;
  render();
  window.scrollTo(0, 0);
}

/* ---- Entrenamiento de un día ---- */

function renderWorkout(k, fromCalendar) {
  const w = data.workouts[k];
  const isToday = k === todayKey();
  const back = fromCalendar ? `<button class="back" data-act="back-cal">‹ Calendario</button>` : '';
  const eyebrow = isToday ? 'Hoy' : relDay(k) === shortDate(k) ? 'Entreno' : cap(relDay(k));
  const header = `
    ${back}
    <div class="header">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1>${esc(longDate(k))}</h1>
    </div>`;

  if (!w || (!w.groups.length && !w.entries.length)) return header + renderGroupPicker(k, isToday);

  const groups = workoutGroups(w);
  let html = header + `
    <div class="header-row">
      <div class="chips">${groups.map((g) => `<span class="chip small on static">${esc(groupById(g).name)}</span>`).join('')}</div>
      <button class="link" data-act="edit-groups" data-date="${k}">Cambiar</button>
    </div>`;

  for (const g of groups) {
    const entries = w.entries.filter((e) => exById(e.exerciseId)?.groupId === g);
    html += `<section class="group-block" data-date="${k}">
      <div class="group-name">${esc(groupById(g).name)}</div>
      ${entries.map((e) => renderEntry(k, e)).join('')}
      <button class="add-ex" data-act="pick-ex" data-group="${g}">+ Añadir ejercicio de ${esc(groupById(g).name.toLowerCase())}</button>
    </section>`;
  }
  return html + '<div class="spacer"></div>';
}

function renderGroupPicker(k, isToday) {
  if (ui.pendingFor !== k) { ui.pending = new Set(); ui.pendingFor = k; }
  const combos = topCombos();
  return `
    <h2>${isToday ? '¿Qué toca hoy?' : '¿Qué entrenaste?'}</h2>
    <div class="chips" data-date="${k}">
      ${data.groups.map((g) => `<button class="chip ${ui.pending.has(g.id) ? 'on' : ''}" data-act="toggle-pending" data-group="${g.id}">${esc(g.name)}</button>`).join('')}
    </div>
    <div class="spacer"></div>
    <button class="btn" data-act="start" data-date="${k}" ${ui.pending.size ? '' : 'disabled'}>Empezar</button>
    ${combos.length ? `
      <h2>Tus combinaciones</h2>
      <div data-date="${k}">
        ${combos.map((c) => `<button class="combo" data-act="start-combo" data-groups="${c.ids.join('|')}">
          ${esc(groupNames(c.ids))}<br><span class="muted">Última vez ${esc(relDay(c.last))} · ${c.n} ${c.n === 1 ? 'vez' : 'veces'}</span>
        </button>`).join('')}
      </div>` : ''}
  `;
}

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderEntry(k, e) {
  const ex = exById(e.exerciseId);
  const prev = lastTime(e.exerciseId, k);
  const lastLine = prev
    ? `Última vez · ${esc(relDay(prev.date))}: ${esc(fmtSets(prev.sets))}`
    : 'Primera vez que lo registras';
  return `
    <div class="card" data-entry="${e.id}">
      <div class="card-head">
        <button class="ex-title" data-act="progress" data-ex="${e.exerciseId}"><h3>${esc(ex ? ex.name : 'Ejercicio eliminado')}</h3><span class="chev">›</span></button>
        <button class="icon-btn" data-act="remove-entry" aria-label="Quitar ejercicio">×</button>
      </div>
      <div class="last">${lastLine}</div>
      <div class="set-head"><span></span><span>Kg</span><span>Reps</span><span></span></div>
      ${e.sets.map((s, i) => `
        <div class="set-row ${s.done ? 'done' : ''}" data-set="${i}">
          <span class="n">${i + 1}</span>
          <div class="stepper">
            <button data-act="step" data-f="w" data-d="-1" aria-label="Menos peso">−</button>
            <input data-f="w" inputmode="decimal" enterkeyhint="done" value="${s.w === '' ? '' : fmtNum(s.w)}" placeholder="kg">
            <button data-act="step" data-f="w" data-d="1" aria-label="Más peso">+</button>
          </div>
          <div class="stepper">
            <button data-act="step" data-f="r" data-d="-1" aria-label="Menos repeticiones">−</button>
            <input data-f="r" inputmode="numeric" enterkeyhint="done" value="${s.r === '' ? '' : s.r}" placeholder="reps">
            <button data-act="step" data-f="r" data-d="1" aria-label="Más repeticiones">+</button>
          </div>
          <button class="check" data-act="toggle-done" aria-label="Serie hecha">${CHECK_SVG}</button>
        </div>`).join('')}
      <div class="card-actions">
        <button data-act="remove-set" ${e.sets.length <= 1 ? 'disabled' : ''}>− Serie</button>
        <button data-act="add-set">+ Serie</button>
      </div>
    </div>`;
}

/* ---- Calendario ---- */

function renderCalendar() {
  const m = ui.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // semana empieza en lunes
  const today = todayKey();

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day out"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const k = keyOf(new Date(m.getFullYear(), m.getMonth(), d));
    const w = data.workouts[k];
    const has = w && (w.groups.length || w.entries.length);
    const tags = has ? workoutGroups(w).map((g) => groupById(g).name.slice(0, 2)).join('·') : '';
    cells += `<button class="cal-day ${has ? 'has' : ''} ${k === today ? 'today' : ''} ${k === ui.calSel ? 'sel' : ''}" data-act="cal-sel" data-date="${k}">
      ${d}${tags ? `<span class="tags">${esc(tags)}</span>` : ''}
    </button>`;
  }

  const monthCount = Object.keys(data.workouts).filter((k) => k.startsWith(`${m.getFullYear()}-${pad(m.getMonth() + 1)}`)).length;

  return `
    <div class="header"><div class="eyebrow">Historial</div><h1>Calendario</h1></div>
    <div class="cal-head">
      <button class="icon-btn" data-act="cal-prev" aria-label="Mes anterior">‹</button>
      <div style="text-align:center">
        <h2>${MONTHS[m.getMonth()]} ${m.getFullYear()}</h2>
        <div class="muted small">${monthCount} ${monthCount === 1 ? 'entreno' : 'entrenos'}</div>
      </div>
      <button class="icon-btn" data-act="cal-next" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal-grid">
      ${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    ${renderDaySummary(ui.calSel)}
  `;
}

function renderDaySummary(k) {
  const w = data.workouts[k];
  const title = `<h2>${esc(longDate(k))}</h2>`;
  if (!w || (!w.groups.length && !w.entries.length)) {
    return `${title}<p class="muted">No hay entreno registrado este día.</p>
      <button class="btn secondary" data-act="open-day" data-date="${k}">Registrar entreno</button>`;
  }
  const items = w.entries.map((e) => {
    const ex = exById(e.exerciseId);
    const sets = fmtSets(e.sets);
    return `<div class="summary-ex"><div class="name">${esc(ex ? ex.name : 'Ejercicio eliminado')}</div>
      <div class="sets">${sets ? esc(sets) : 'Sin datos'}</div></div>`;
  }).join('');
  return `${title}
    <div class="chips">${workoutGroups(w).map((g) => `<span class="chip small on static">${esc(groupById(g).name)}</span>`).join('')}</div>
    <div class="spacer"></div>
    ${items ? `<div class="card">${items}</div>` : '<p class="muted">Aún sin ejercicios.</p>'}
    <button class="btn secondary" data-act="open-day" data-date="${k}">Abrir y editar</button>`;
}

/* ---- Editor de ejercicios ---- */

function renderExercises() {
  return `
    <div class="header"><div class="eyebrow">Tu biblioteca</div><h1>Ejercicios</h1></div>
    <p class="muted small">Ponle a cada ejercicio el nombre que uses tú. Si cambias un nombre, se cambia también en todo tu historial.</p>
    ${data.groups.map((g) => {
      const list = exercisesOf(g.id);
      return `
        <div class="section-title">
          <h2>${esc(g.name)}</h2>
          <span>
            <button class="icon-btn" data-act="rename-group" data-group="${g.id}" aria-label="Renombrar grupo">✎</button>
            <button class="icon-btn" data-act="delete-group" data-group="${g.id}" aria-label="Eliminar grupo">🗑</button>
          </span>
        </div>
        <div class="list">
          ${list.map((e) => `
            <div class="list-item">
              <button class="grow ex-link" data-act="progress" data-ex="${e.id}">${esc(e.name)}<span class="sub">Ver progreso ›</span></button>
              <button class="icon-btn" data-act="rename-ex" data-ex="${e.id}" aria-label="Renombrar">✎</button>
              <button class="icon-btn" data-act="delete-ex" data-ex="${e.id}" aria-label="Eliminar">🗑</button>
            </div>`).join('')}
          <form class="add-row" data-act="add-ex-form" data-group="${g.id}">
            <input class="text-input" name="name" placeholder="Nuevo ejercicio de ${esc(g.name.toLowerCase())}" autocomplete="off" enterkeyhint="done">
            <button type="submit">Añadir</button>
          </form>
        </div>`;
    }).join('')}
    <h2>Grupos musculares</h2>
    <div class="list">
      <form class="add-row" data-act="add-group-form">
        <input class="text-input" name="name" placeholder="Nuevo grupo (p. ej. Glúteo)" autocomplete="off" enterkeyhint="done">
        <button type="submit">Añadir</button>
      </form>
    </div>
  `;
}

/* ---- Ajustes ---- */

function renderSettings() {
  const nWorkouts = Object.keys(data.workouts).length;
  const nEx = data.exercises.filter((e) => !e.archived).length;
  return `
    <div class="header"><div class="eyebrow">Configuración</div><h1>Ajustes</h1></div>
    <div class="list">
      <div class="setting">
        <div>Series por defecto</div>
        <div class="stepper">
          <button data-act="setting-step" data-key="defaultSets" data-d="-1">−</button>
          <input value="${data.settings.defaultSets}" readonly>
          <button data-act="setting-step" data-key="defaultSets" data-d="1">+</button>
        </div>
      </div>
      <div class="setting">
        <div>Salto de peso (kg)</div>
        <div class="stepper">
          <button data-act="setting-step" data-key="weightStep" data-d="-1">−</button>
          <input value="${fmtNum(data.settings.weightStep)}" readonly>
          <button data-act="setting-step" data-key="weightStep" data-d="1">+</button>
        </div>
      </div>
    </div>

    <h2>Descanso entre series</h2>
    <div class="list">
      <div class="setting">
        <div>Temporizador de descanso<div class="sub">Arranca al marcar una serie como hecha</div></div>
        <button class="switch ${data.settings.restEnabled ? 'on' : ''}" role="switch" aria-checked="${data.settings.restEnabled}" data-act="toggle-rest" aria-label="Temporizador de descanso"><i></i></button>
      </div>
      ${data.settings.restEnabled ? `
      <div class="setting">
        <div>Duración</div>
        <div class="stepper">
          <button data-act="setting-step" data-key="restSeconds" data-d="-1">−</button>
          <input value="${fmtTime(data.settings.restSeconds)}" readonly>
          <button data-act="setting-step" data-key="restSeconds" data-d="1">+</button>
        </div>
      </div>` : ''}
    </div>

    <h2>Copia de seguridad</h2>
    <p class="muted small">${ui.user
      ? 'Tus datos ya se guardan en tu cuenta. Si quieres, también puedes guardar una copia en un archivo (por ejemplo en Archivos o iCloud Drive).'
      : 'Tus datos solo están en este dispositivo. Exporta una copia de vez en cuando (por ejemplo a Archivos o iCloud Drive) para no perderlos nunca.'}</p>
    <div class="stack">
      <button class="btn" data-act="export">Exportar copia</button>
      <button class="btn secondary" data-act="import">Importar copia</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>
    <p class="muted small">${nWorkouts} ${nWorkouts === 1 ? 'entreno' : 'entrenos'} y ${nEx} ${nEx === 1 ? 'ejercicio' : 'ejercicios'} guardados.</p>

    ${renderAccount()}

    <h2>Zona peligrosa</h2>
    <button class="btn danger" data-act="reset">Borrar todos los datos</button>
    <div class="spacer"></div>
    <p class="muted small" style="text-align:center">Gym · v7</p>
  `;
}

/* ---------------- Hojas (bottom sheets) ---------------- */

function openSheet(html) {
  $('#sheet-body').innerHTML = `<div class="grabber"></div>${html}`;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-body').innerHTML = '';
  document.body.style.overflow = '';
}

function openExercisePicker(k, groupId) {
  const g = groupById(groupId);
  const w = data.workouts[k];
  const used = new Set(w ? w.entries.map((e) => e.exerciseId) : []);
  const list = exercisesOf(groupId);
  openSheet(`
    <h2>${esc(g.name)}</h2>
    <div data-date="${k}" data-group="${groupId}">
      ${list.length ? list.map((e) => {
        const prev = lastTime(e.id, k);
        return `<button class="pick-item" data-act="pick" data-ex="${e.id}" ${used.has(e.id) ? 'disabled' : ''}>
          <span>${esc(e.name)}<br><span class="muted small" style="font-weight:400">${used.has(e.id) ? 'Ya añadido' : prev ? `${esc(relDay(prev.date))} · ${esc(fmtSets(prev.sets))}` : 'Sin registros'}</span></span>
          <span class="plus">${used.has(e.id) ? '✓' : '+'}</span>
        </button>`;
      }).join('') : `<p class="muted">Todavía no tienes ejercicios de ${esc(g.name.toLowerCase())}. Crea el primero:</p>`}
      <div class="list" style="margin-top:10px">
        <form class="add-row" data-act="create-and-add">
          <input class="text-input" name="name" placeholder="Nuevo ejercicio…" autocomplete="off" enterkeyhint="done">
          <button type="submit">Crear</button>
        </form>
      </div>
    </div>
  `);
}

function openGroupEditor(k) {
  const w = data.workouts[k];
  const current = new Set(workoutGroups(w));
  openSheet(`
    <h2>Grupos de este día</h2>
    <div class="chips" data-date="${k}">
      ${data.groups.map((g) => `<button class="chip ${current.has(g.id) ? 'on' : ''}" data-act="toggle-group" data-group="${g.id}">${esc(g.name)}</button>`).join('')}
    </div>
    <p class="muted small">Si quitas un grupo, se quitan también sus ejercicios de este día.</p>
    <div class="stack" data-date="${k}">
      <button class="btn" data-act="close-sheet">Listo</button>
      <button class="btn danger" data-act="delete-day">Borrar el entreno de este día</button>
    </div>
  `);
}

/* ---------------- Utilidades ---------------- */

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function vibrate(ms = 10) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

function ctx(el) {
  const dateEl = el.closest('[data-date]');
  const entryEl = el.closest('[data-entry]');
  const setEl = el.closest('[data-set]');
  const k = dateEl ? dateEl.dataset.date : null;
  const w = k ? data.workouts[k] : null;
  const entry = w && entryEl ? w.entries.find((e) => e.id === entryEl.dataset.entry) : null;
  const setIdx = setEl ? Number(setEl.dataset.set) : null;
  return { k, w, entry, setIdx, entryEl, setEl };
}

/* ---------------- Acciones ---------------- */

const actions = {
  'toggle-pending'(el) {
    const id = el.dataset.group;
    ui.pending.has(id) ? ui.pending.delete(id) : ui.pending.add(id);
    render();
  },
  start(el) {
    const k = el.dataset.date;
    ensureWorkout(k).groups = sortGroups([...ui.pending]);
    ui.pending = new Set();
    save(); render();
  },
  'start-combo'(el) {
    const { k } = ctx(el);
    ensureWorkout(k).groups = sortGroups(el.dataset.groups.split('|'));
    save(); render();
  },
  'edit-groups'(el) { openGroupEditor(el.dataset.date); },
  'toggle-group'(el) {
    const { k, w } = ctx(el);
    const g = el.dataset.group;
    const current = new Set(workoutGroups(w));
    if (current.has(g)) {
      const affected = w.entries.filter((e) => exById(e.exerciseId)?.groupId === g);
      if (affected.length && !confirm(`Se quitarán ${affected.length} ${affected.length === 1 ? 'ejercicio' : 'ejercicios'} de ${groupById(g).name.toLowerCase()} de este día. ¿Seguir?`)) return;
      w.groups = w.groups.filter((x) => x !== g);
      w.entries = w.entries.filter((e) => exById(e.exerciseId)?.groupId !== g);
      el.classList.remove('on');
    } else {
      w.groups = sortGroups([...w.groups, g]);
      el.classList.add('on');
    }
    save();
    if (!w.groups.length && !w.entries.length) { cleanupWorkout(k); save(); closeSheet(); }
    render();
  },
  'delete-day'(el) {
    const { k } = ctx(el);
    if (!confirm('¿Borrar todo el entreno de este día?')) return;
    delete data.workouts[k];
    save(); closeSheet(); render();
    toast('Entreno borrado');
  },
  'pick-ex'(el) { openExercisePicker(ctx(el).k, el.dataset.group); },
  pick(el) {
    const { k } = ctx(el);
    addEntry(k, el.dataset.ex);
    closeSheet(); render();
  },
  'remove-entry'(el) {
    const { w, entry } = ctx(el);
    const name = exById(entry.exerciseId)?.name || 'este ejercicio';
    if (!confirm(`¿Quitar "${name}" de este día?`)) return;
    w.entries = w.entries.filter((e) => e !== entry);
    save(); render();
  },
  'add-set'(el) {
    const { entry } = ctx(el);
    const last = entry.sets[entry.sets.length - 1] || { w: '', r: '' };
    entry.sets.push({ w: last.w, r: last.r, done: false });
    save(); render();
  },
  'remove-set'(el) {
    const { entry } = ctx(el);
    if (entry.sets.length > 1) entry.sets.pop();
    save(); render();
  },
  step(el) {
    const { entry, setIdx, setEl } = ctx(el);
    const s = entry.sets[setIdx];
    const f = el.dataset.f;
    const dir = Number(el.dataset.d);
    const stepSize = f === 'w' ? data.settings.weightStep : 1;
    const cur = s[f] === '' ? (dir > 0 ? 0 : stepSize) : Number(s[f]);
    let next = Math.max(0, Math.round((cur + dir * stepSize) * 100) / 100);
    s[f] = next;
    setEl.querySelector(`input[data-f="${f}"]`).value = f === 'w' ? fmtNum(next) : next;
    save(); vibrate();
  },
  'toggle-done'(el) {
    const { entry, setIdx, setEl } = ctx(el);
    const s = entry.sets[setIdx];
    s.done = !s.done;
    setEl.classList.toggle('done', s.done);
    save(); vibrate(s.done ? 20 : 10);
    if (s.done) {
      unlockAudio();
      startRest();
      checkRecord(ctx(el).k, entry, s);
    }
  },
  progress(el) { openProgress(el.dataset.ex); },
  'progress-metric'(el) { openProgress(el.dataset.ex, el.dataset.metric); },
  'chart-pt'(el) {
    document.querySelectorAll('.chart .pt.sel').forEach((x) => x.classList.remove('sel'));
    const dot = el.parentNode.querySelector('.pt');
    if (dot) dot.classList.add('sel');
    const r = $('#chart-readout');
    if (r) r.innerHTML = el.dataset.label;
  },
  'rest-add'(el) { addRest(Number(el.dataset.d)); },
  'rest-stop'() { stopRest(); },
  'toggle-rest'() {
    data.settings.restEnabled = !data.settings.restEnabled;
    if (!data.settings.restEnabled) stopRest();
    save(); render(); vibrate();
  },

  // Calendario
  'cal-prev'() { ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() - 1, 1); render(); },
  'cal-next'() { ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + 1, 1); render(); },
  'cal-sel'(el) { ui.calSel = el.dataset.date; render(); },
  'open-day'(el) {
    const k = el.dataset.date;
    if (k === todayKey()) { go('today'); return; }
    ui.dayKey = k; render(); window.scrollTo(0, 0);
  },
  'back-cal'() { ui.dayKey = null; render(); },

  // Biblioteca
  'rename-ex'(el) {
    const ex = exById(el.dataset.ex);
    const name = prompt('Nuevo nombre del ejercicio', ex.name);
    if (name == null || !name.trim()) return;
    const clash = data.exercises.find((e) => e !== ex && e.groupId === ex.groupId && !e.archived && e.name.toLowerCase() === name.trim().toLowerCase());
    if (clash) { toast('Ya existe un ejercicio con ese nombre'); return; }
    ex.name = name.trim();
    save(); render();
  },
  'delete-ex'(el) {
    const ex = exById(el.dataset.ex);
    if (isUsed(ex.id)) {
      if (!confirm(`"${ex.name}" aparece en tu historial. Se ocultará de la lista pero sus registros se conservan. ¿Seguir?`)) return;
      ex.archived = true;
    } else {
      if (!confirm(`¿Eliminar "${ex.name}"?`)) return;
      data.exercises = data.exercises.filter((e) => e !== ex);
    }
    save(); render();
  },
  'rename-group'(el) {
    const g = groupById(el.dataset.group);
    const name = prompt('Nuevo nombre del grupo', g.name);
    if (name == null || !name.trim()) return;
    g.name = name.trim();
    save(); render();
  },
  'delete-group'(el) {
    const g = groupById(el.dataset.group);
    const hasEx = data.exercises.some((e) => e.groupId === g.id);
    const inHistory = Object.values(data.workouts).some((w) => w.groups.includes(g.id));
    if (hasEx || inHistory) { toast('Solo se pueden borrar grupos sin ejercicios ni historial'); return; }
    if (!confirm(`¿Eliminar el grupo "${g.name}"?`)) return;
    data.groups = data.groups.filter((x) => x !== g);
    save(); render();
  },

  // Ajustes
  'setting-step'(el) {
    const key = el.dataset.key;
    const d = Number(el.dataset.d);
    if (key === 'defaultSets') data.settings.defaultSets = Math.min(10, Math.max(1, data.settings.defaultSets + d));
    if (key === 'weightStep') {
      const opts = [0.5, 1, 1.25, 2, 2.5, 5];
      const i = Math.max(0, opts.indexOf(data.settings.weightStep));
      data.settings.weightStep = opts[Math.min(opts.length - 1, Math.max(0, i + d))];
    }
    if (key === 'restSeconds') {
      const i = Math.max(0, REST_OPTS.indexOf(data.settings.restSeconds));
      data.settings.restSeconds = REST_OPTS[Math.min(REST_OPTS.length - 1, Math.max(0, i + d))];
    }
    save(); render();
  },
  async export() {
    const json = JSON.stringify(data, null, 2);
    const name = `gym-copia-${todayKey()}.json`;
    const file = new File([json], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Copia de Gym' });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  import() { $('#import-file').click(); },
  reset() {
    if (!confirm('Se borrarán TODOS tus entrenos y ejercicios. ¿Seguro?')) return;
    if (!confirm('Última confirmación: esto no se puede deshacer.')) return;
    data = freshData();
    if (ui.user) data.owner = ui.user.uid;
    save(); render();
    toast('Datos borrados');
  },

  'close-sheet'() { closeSheet(); render(); },
};

/* ---------------- Eventos ---------------- */

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-tab]');
  if (tab) { closeSheet(); go(tab.dataset.tab); return; }
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM') return;
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('input', (ev) => {
  const input = ev.target;
  if (!input.matches('input[data-f]')) return;
  const { entry, setIdx } = ctx(input);
  if (!entry) return;
  entry.sets[setIdx][input.dataset.f] = parseNum(input.value);
  save();
});

document.addEventListener('focusin', (ev) => {
  if (ev.target.matches('input[data-f]')) setTimeout(() => ev.target.select(), 0);
});

document.addEventListener('submit', (ev) => {
  const form = ev.target;
  ev.preventDefault();
  if (form.dataset.act === 'auth-form') { doAuth(form); return; }
  const name = form.elements.name.value;
  const act = form.dataset.act;
  if (act === 'add-ex-form') {
    if (createExercise(form.dataset.group, name)) { render(); toast('Ejercicio añadido'); }
  } else if (act === 'add-group-form') {
    const n = name.trim();
    if (!n) return;
    if (data.groups.some((g) => g.name.toLowerCase() === n.toLowerCase())) { toast('Ese grupo ya existe'); return; }
    data.groups.push({ id: uid(), name: n });
    save(); render(); toast('Grupo añadido');
  } else if (act === 'create-and-add') {
    const { k } = ctx(form);
    const groupId = form.closest('[data-group]').dataset.group;
    const ex = createExercise(groupId, name);
    if (ex) { addEntry(k, ex.id); closeSheet(); render(); }
  }
  if (document.activeElement) document.activeElement.blur();
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'import-file') return;
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.groups) || typeof parsed.workouts !== 'object') throw new Error('formato');
    if (!confirm('Esto sustituirá los datos actuales por los de la copia. ¿Seguir?')) return;
    const owner = data.owner;
    data = normalize(parsed);
    if (owner) data.owner = owner; else delete data.owner;
    save(); render();
    toast('Copia importada');
  } catch (e) {
    toast('Ese archivo no es una copia válida');
  } finally {
    ev.target.value = '';
  }
});

// Si la app se queda abierta y cambia el día, refrescar al volver.
let lastSeenDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') cloud.flush();
  if (document.visibilityState === 'visible' && rest.timer) tickRest();
  if (document.visibilityState === 'visible' && todayKey() !== lastSeenDay) {
    lastSeenDay = todayKey();
    ui.calSel = lastSeenDay;
    render();
  }
});

/* ---------------- Progreso y récords ---------------- */

const better = (a, b) => !b || a.w > b.w || (a.w === b.w && a.r > b.r);
const validSet = (s) => s.w !== '' && s.r !== '' && Number(s.r) > 0;

function topSet(sets) {
  let top = null;
  for (const s of sets) if (validSet(s) && better({ w: Number(s.w), r: Number(s.r) }, top)) top = { w: Number(s.w), r: Number(s.r) };
  return top;
}

// Sesiones de un ejercicio, de la más antigua a la más reciente.
function exerciseHistory(exId) {
  const out = [];
  let best = null;
  for (const k of Object.keys(data.workouts).sort()) {
    const e = data.workouts[k].entries.find((x) => x.exerciseId === exId);
    if (!e) continue;
    const sets = e.sets.filter(validSet).map((s) => ({ w: Number(s.w), r: Number(s.r) }));
    if (!sets.length) continue;
    const top = topSet(sets);
    const record = !!best && better(top, best);
    if (better(top, best)) best = top;
    out.push({
      date: k, sets, top, record,
      volume: sets.reduce((a, s) => a + s.w * s.r, 0),
      maxReps: Math.max(...sets.map((s) => s.r)),
      totalReps: sets.reduce((a, s) => a + s.r, 0),
    });
  }
  return out;
}

function bestBefore(exId, k) {
  let best = null;
  for (const d of Object.keys(data.workouts)) {
    if (d >= k) continue;
    const e = data.workouts[d].entries.find((x) => x.exerciseId === exId);
    if (e) { const t = topSet(e.sets); if (t && better(t, best)) best = t; }
  }
  return best;
}

function checkRecord(k, entry, s) {
  if (!validSet(s)) return;
  const prev = bestBefore(entry.exerciseId, k);
  if (!prev) return; // la primera vez no cuenta como récord
  const cur = { w: Number(s.w), r: Number(s.r) };
  const others = topSet(entry.sets.filter((x) => x !== s && x.done));
  if (better(cur, prev) && better(cur, others)) {
    const ex = exById(entry.exerciseId);
    toast(`🏆 ¡Nuevo récord en ${ex ? ex.name : 'este ejercicio'}! ${fmtNum(cur.w)} kg × ${cur.r}`, 4000);
    vibrate([30, 60, 30]);
  }
}

function niceScale(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

function renderChart(points, unit, exId) {
  const W = 340, H = 190, L = 40, R = 14, T = 14, B = 26;
  const t0 = dateOf(points[0].date).getTime();
  const t1 = dateOf(points[points.length - 1].date).getTime();
  const vals = points.map((p) => p.v);
  const { lo, hi, ticks } = niceScale(Math.min(...vals), Math.max(...vals));
  const x = (d) => L + (t1 === t0 ? (W - L - R) / 2 : ((dateOf(d).getTime() - t0) / (t1 - t0)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const grid = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmtNum(v))}</text>`).join('');
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const dots = points.map((p, i) => {
    const label = `<b>${esc(shortDate(p.date))}</b> · ${esc(fmtNum(p.v))} ${unit}${p.detail ? ` <span class="muted">(${esc(p.detail)})</span>` : ''}${p.record ? ' 🏆' : ''}`;
    return `<g><circle class="pt ${i === points.length - 1 ? 'sel' : ''} ${p.record ? 'rec' : ''}" cx="${x(p.date)}" cy="${y(p.v)}" r="4.5"/>
      <circle class="hit" cx="${x(p.date)}" cy="${y(p.v)}" r="16" data-act="chart-pt" data-label="${esc(label)}"/></g>`;
  }).join('');
  const xl = `<text class="axis" x="${L}" y="${H - 6}" text-anchor="start">${esc(shortDate(points[0].date))}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(shortDate(last.date))}</text>`;
  const lastLabel = `<b>${esc(shortDate(last.date))}</b> · ${esc(fmtNum(last.v))} ${unit}${last.detail ? ` <span class="muted">(${esc(last.detail)})</span>` : ''}${last.record ? ' 🏆' : ''}`;
  return `<div class="chart-readout" id="chart-readout">${lastLabel}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfica de progreso">${grid}<path class="line" d="${path}"/>${dots}${xl}</svg>
    <p class="muted small" style="text-align:center;margin:4px 0 0">Toca un punto para ver su valor. 🏆 = récord</p>`;
}

function openProgress(exId, metric) {
  const ex = exById(exId);
  if (!ex) return;
  const hist = exerciseHistory(exId);
  const bodyweight = hist.length > 0 && hist.every((h) => h.top.w === 0);
  const metrics = bodyweight
    ? [['reps', 'Máx. repeticiones'], ['totalReps', 'Repeticiones totales']]
    : [['peso', 'Peso máximo'], ['volumen', 'Volumen']];
  if (!metric || !metrics.some((m) => m[0] === metric)) metric = metrics[0][0];

  let body = '';
  if (!hist.length) {
    body = `<p class="muted">Todavía no has registrado este ejercicio. Cuando lo hagas, aquí verás tu evolución y tus récords.</p>`;
  } else {
    const best = hist.reduce((b, h) => (better(h.top, b.top) ? h : b), hist[0]);
    const first = hist[0], last = hist[hist.length - 1];
    let change = '';
    if (hist.length > 1) {
      const dv = bodyweight ? last.maxReps - first.maxReps : last.top.w - first.top.w;
      const sign = dv > 0 ? '+' : dv < 0 ? '−' : '';
      change = `${sign}${fmtNum(Math.abs(dv))} ${bodyweight ? 'reps' : 'kg'}`;
    }
    const tiles = `
      <div class="tiles">
        <div class="tile"><span>Récord</span><b>${bodyweight ? `${best.top.r} reps` : `${fmtNum(best.top.w)} kg × ${best.top.r}`}</b><em>${esc(shortDate(best.date))}</em></div>
        <div class="tile"><span>Sesiones</span><b>${hist.length}</b><em>desde ${esc(shortDate(first.date))}</em></div>
        <div class="tile"><span>Evolución</span><b>${change || '—'}</b><em>${hist.length > 1 ? 'desde la 1.ª vez' : 'falta otra sesión'}</em></div>
      </div>`;
    const toggle = `<div class="seg">${metrics.map(([id, name]) =>
      `<button class="${id === metric ? 'on' : ''}" data-act="progress-metric" data-ex="${exId}" data-metric="${id}">${name}</button>`).join('')}</div>`;
    const pts = hist.map((h) => {
      if (metric === 'peso') return { date: h.date, v: h.top.w, detail: `× ${h.top.r}`, record: h.record };
      if (metric === 'volumen') return { date: h.date, v: Math.round(h.volume), detail: `${h.sets.length} series`, record: h.record };
      if (metric === 'reps') return { date: h.date, v: h.maxReps, detail: '', record: h.record };
      return { date: h.date, v: h.totalReps, detail: `${h.sets.length} series`, record: h.record };
    });
    const unit = metric === 'peso' || metric === 'volumen' ? 'kg' : 'reps';
    const chart = hist.length < 2
      ? `<p class="muted small chart-empty">Con una sesión más aparecerá aquí la gráfica de tu evolución.</p>`
      : renderChart(pts, unit, exId);
    const explain = metric === 'volumen'
      ? '<p class="muted small">Volumen = suma de peso × repeticiones de todas las series del día.</p>' : '';
    const list = hist.slice().reverse().map((h) => `
      <div class="hist-row ${h.record ? 'rec' : ''}">
        <div><b>${esc(cap(relDay(h.date)))}</b>${relDay(h.date) !== shortDate(h.date) ? ` <span class="muted small">${esc(shortDate(h.date))}</span>` : ''}${h.record ? ' <span class="pr">🏆 Récord</span>' : ''}</div>
        <div class="muted small">${esc(fmtSets(h.sets))}</div>
      </div>`).join('');
    body = tiles + toggle + chart + explain + `<h2>Historial</h2><div class="card">${list}</div>`;
  }
  openSheet(`
    <div class="eyebrow-s">${esc(groupById(ex.groupId)?.name || '')} · Progreso</div>
    <h2 style="margin-top:2px">${esc(ex.name)}</h2>
    ${body}
  `);
}

/* ---------------- Temporizador de descanso ---------------- */

const REST_OPTS = [30, 45, 60, 75, 90, 120, 150, 180, 240, 300];
const fmtTime = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
const rest = { end: 0, total: 0, timer: null, hideTimer: null };
let audioCtx = null;

function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* sin sonido */ }
}

function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((dt, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = i === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.4, t + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + dt); o.stop(t + dt + 0.2);
  });
}

function startRest() {
  const sec = data.settings.restSeconds;
  if (!data.settings.restEnabled || !sec) return;
  rest.total = sec;
  rest.end = Date.now() + sec * 1000;
  clearTimeout(rest.hideTimer);
  $('#rest').classList.remove('finished');
  $('#rest').hidden = false;
  clearInterval(rest.timer);
  rest.timer = setInterval(tickRest, 250);
  tickRest();
}

function addRest(d) {
  if (!rest.timer) return;
  rest.end += d * 1000;
  rest.total = Math.max(rest.total + d, 1);
  tickRest();
}

function stopRest() {
  clearInterval(rest.timer); rest.timer = null;
  clearTimeout(rest.hideTimer);
  $('#rest').hidden = true;
}

function tickRest() {
  const left = Math.max(0, Math.ceil((rest.end - Date.now()) / 1000));
  $('#rest-time').textContent = fmtTime(left);
  $('#rest-fill').style.width = `${Math.min(100, (1 - left / rest.total) * 100)}%`;
  if (left <= 0) {
    clearInterval(rest.timer); rest.timer = null;
    const el = $('#rest');
    el.classList.add('finished');
    $('#rest-time').textContent = '¡Siguiente serie!';
    if (document.visibilityState === 'visible') { beep(); vibrate([200, 100, 200]); }
    rest.hideTimer = setTimeout(() => { el.hidden = true; el.classList.remove('finished'); }, 5000);
  }
}

/* ---------------- Cuenta ---------------- */

function renderLogin() {
  const email = esc(ui.authEmail || '');
  if (ui.authView === 'signup') {
    return `
      <button class="back" data-act="auth-view" data-view="login">‹ Iniciar sesión</button>
      <div class="header"><div class="eyebrow">Nueva cuenta</div><h1>Crear cuenta</h1></div>
      <p class="muted">Tus entrenos se guardarán en tu cuenta y podrás verlos en cualquier dispositivo.</p>
      <form class="stack" data-act="auth-form" data-mode="up" novalidate>
        <label class="field-label" for="f-email">Correo electrónico</label>
        <input class="text-input block" id="f-email" name="email" type="email" value="${email}" placeholder="tucorreo@gmail.com" autocomplete="email" autocapitalize="off" spellcheck="false">
        <label class="field-label" for="f-pw">Contraseña</label>
        <input class="text-input block" id="f-pw" name="password" type="password" placeholder="Mínimo 6 caracteres" autocomplete="new-password">
        <label class="field-label" for="f-pw2">Repetir contraseña</label>
        <input class="text-input block" id="f-pw2" name="password2" type="password" placeholder="Vuelve a escribirla" autocomplete="new-password">
        <p class="auth-error" id="auth-error" hidden></p>
        <button class="btn" type="submit">Crear cuenta</button>
      </form>`;
  }
  return `
    <div class="header"><div class="eyebrow">Bienvenido</div><h1>Iniciar sesión</h1></div>
    <p class="muted">Entra en tu cuenta para ver tus entrenos en cualquier dispositivo.</p>
    <form class="stack" data-act="auth-form" data-mode="in" novalidate>
      <label class="field-label" for="f-email">Correo electrónico</label>
      <input class="text-input block" id="f-email" name="email" type="email" value="${email}" placeholder="tucorreo@gmail.com" autocomplete="email" autocapitalize="off" spellcheck="false">
      <label class="field-label" for="f-pw">Contraseña</label>
      <input class="text-input block" id="f-pw" name="password" type="password" placeholder="Tu contraseña" autocomplete="current-password">
      <p class="auth-error" id="auth-error" hidden></p>
      <button class="btn" type="submit">Entrar</button>
      <div style="text-align:center"><button type="button" class="link" data-act="reset-pw">¿Has olvidado la contraseña?</button></div>
    </form>
    <div class="divider"><span>¿No tienes cuenta?</span></div>
    <button class="btn secondary" data-act="auth-view" data-view="signup">Crear cuenta</button>
    <div class="spacer"></div>
    <div style="text-align:center"><button class="link muted-link small" data-act="use-local">Usar sin cuenta (solo en este dispositivo)</button></div>`;
}

function renderAccount() {
  if (!cloud.cloudEnabled) return '';
  if (ui.user) {
    return `
      <h2>Cuenta</h2>
      <div class="list"><div class="list-item"><div class="grow">${esc(ui.user.email)}<div class="sub">Sincronizado en la nube</div></div></div></div>
      <div class="spacer"></div>
      <button class="btn secondary" data-act="logout">Cerrar sesión</button>`;
  }
  return `
    <h2>Cuenta</h2>
    <p class="muted small">Ahora mismo tus datos solo están en este dispositivo. Inicia sesión para sincronizarlos.</p>
    <button class="btn secondary" data-act="go-login">Iniciar sesión</button>`;
}

function authError(msg) {
  const el = $('#auth-error');
  if (!el) { toast(msg); return; }
  el.textContent = msg; el.hidden = !msg;
}

async function doAuth(form) {
  const mode = form.dataset.mode;
  const email = form.elements.email.value.trim();
  const pw = form.elements.password.value;
  ui.authEmail = email;
  if (!email) { authError('Escribe tu correo electrónico.'); return; }
  if (!pw) { authError('Escribe tu contraseña.'); return; }
  if (mode === 'up') {
    if (pw.length < 6) { authError('La contraseña debe tener al menos 6 caracteres.'); return; }
    if (pw !== form.elements.password2.value) { authError('Las contraseñas no coinciden.'); return; }
  }
  authError('');
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (mode === 'up') await cloud.signUp(email, pw);
    else await cloud.signIn(email, pw);
  } catch (e) {
    authError(cloud.errorText(e, mode));
    buttons.forEach((b) => { b.disabled = false; });
  }
}

Object.assign(actions, {
  'auth-view'(el) {
    const input = $('input[name=email]');
    if (input) ui.authEmail = input.value.trim();
    ui.authView = el.dataset.view;
    render(); window.scrollTo(0, 0);
  },
  async 'reset-pw'() {
    const email = ($('input[name=email]') || {}).value;
    if (!email) { authError('Escribe tu correo arriba y vuelve a pulsar aquí.'); return; }
    try { await cloud.resetPassword(email.trim()); toast('Te hemos enviado un correo para cambiar la contraseña'); }
    catch (e) { authError(cloud.errorText(e)); }
  },
  'use-local'() { localStorage.setItem(MODE_KEY, 'local'); render(); },
  'go-login'() { localStorage.removeItem(MODE_KEY); render(); window.scrollTo(0, 0); },
  async logout() {
    if (!confirm('¿Cerrar sesión? Tus datos seguirán guardados en tu cuenta.')) return;
    await cloud.logOut();
  },
});

function startLiveSync(uid) {
  cloud.startSync(uid, () => data, () => {
    const typing = document.activeElement && document.activeElement.matches('input');
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
    if (!typing && !ui.syncing) render();
  });
}

async function onUser(user) {
  ui.authReady = true;
  if (user && data.owner === user.uid) {
    // Ya teníamos sus datos en este dispositivo: arrancar al instante y sincronizar en segundo plano.
    ui.user = user;
    startLiveSync(user.uid);
    render();
    return;
  }
  if (!user) {
    cloud.stopSync();
    if (ui.user) {
      // Al cerrar sesión, este dispositivo se queda limpio.
      data = freshData();
      save();
    }
    ui.user = null;
    render();
    return;
  }
  ui.user = user;
  ui.syncing = true;
  render();
  try {
    const remote = await cloud.loadAll(user.uid);
    const local = data;
    const localIsOther = local.owner && local.owner !== user.uid;
    if (!remote) {
      // Cuenta nueva: se suben los datos de este dispositivo (si eran de esta persona o de nadie).
      data = localIsOther ? freshData() : local;
      data.owner = user.uid;
      await cloud.uploadAll(user.uid, data);
      if (!localIsOther && hasOwnContent(local)) toast('Tus datos se han subido a tu cuenta');
    } else {
      let merged = normalize(remote);
      if (!local.owner && hasOwnContent(local) &&
          confirm('Este dispositivo tiene entrenos que no están en tu cuenta. ¿Quieres añadirlos?')) {
        merged = mergeLocalInto(merged, local);
        await cloud.uploadAll(user.uid, merged);
      }
      data = merged;
      data.owner = user.uid;
    }
    localStorage.removeItem(MODE_KEY);
    save();
    startLiveSync(user.uid);
  } catch (e) {
    console.error(e);
    toast('No se han podido cargar tus datos. Revisa la conexión.');
  } finally {
    ui.syncing = false;
    render();
  }
}

/* ---------------- Arranque ---------------- */

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
render();
cloud.initCloud(onUser).catch((e) => { console.error(e); ui.authReady = true; render(); });
