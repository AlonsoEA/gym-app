// Sincronización con Firebase (Auth + Firestore).
// Estructura en Firestore:
//   users/{uid}                      -> { groups, exercises, settings }
//   users/{uid}/workouts/{AAAA-MM-DD} -> { groups, entries }

import { FIREBASE_CONFIG } from './firebase-config.js';

export const cloudEnabled = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);

let fb, auth, db, uid = null;
let lastMeta = null;
let lastW = {};
let timer = null;
let getData = () => null;
let unsubs = [];

export const metaOf = (d) => ({ groups: d.groups, exercises: d.exercises, settings: d.settings });
const metaStr = (d) => JSON.stringify(metaOf(d));

export async function initCloud(onUser) {
  if (!cloudEnabled) return;
  fb = await import('./vendor/firebase.js');
  const app = fb.initializeApp(FIREBASE_CONFIG);
  auth = fb.getAuth(app);
  try { await fb.setPersistence(auth, fb.indexedDBLocalPersistence); }
  catch { await fb.setPersistence(auth, fb.browserLocalPersistence).catch(() => {}); }
  try {
    db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  } catch {
    db = fb.initializeFirestore(app, {});
  }
  fb.onAuthStateChanged(auth, (user) => onUser(user));
}

export const signIn = (email, pw) => fb.signInWithEmailAndPassword(auth, email, pw);
export const signUp = (email, pw) => fb.createUserWithEmailAndPassword(auth, email, pw);
export const resetPassword = (email) => fb.sendPasswordResetEmail(auth, email);
export async function logOut() {
  await flush();
  stopSync();
  await fb.signOut(auth);
}

export function errorText(e, mode = 'in') {
  const code = (e && e.code) || '';
  if (mode === 'in') {
    if (code === 'auth/user-not-found') return 'Este correo no está registrado. Pulsa "Crear cuenta" para registrarte.';
    if (code === 'auth/wrong-password') return 'La contraseña no es correcta.';
    if (code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials')
      return 'Correo o contraseña incorrectos. Si aún no tienes cuenta, pulsa "Crear cuenta".';
  }
  const map = {
    'auth/invalid-email': 'El correo electrónico no es válido.',
    'auth/missing-password': 'Escribe tu contraseña.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/email-already-in-use': 'Este correo ya tiene una cuenta. Vuelve atrás e inicia sesión.',
    'auth/too-many-requests': 'Demasiados intentos. Espera un poco y vuelve a probar.',
    'auth/network-request-failed': 'Sin conexión. Inténtalo cuando tengas internet.',
    'auth/user-not-found': 'Este correo no está registrado.',
  };
  return map[code] || 'Ha ocurrido un error. Inténtalo de nuevo.';
}

/* ---------- Carga inicial ---------- */

async function getDocBest(ref) {
  try { return await fb.getDocFromServer(ref); } catch { return fb.getDoc(ref); }
}
async function getDocsBest(ref) {
  try { return await fb.getDocsFromServer(ref); } catch { return fb.getDocs(ref); }
}

// Devuelve null si la cuenta todavía no tiene datos en la nube.
export async function loadAll(userId) {
  const metaSnap = await getDocBest(fb.doc(db, 'users', userId));
  if (!metaSnap.exists()) return null;
  const wSnap = await getDocsBest(fb.collection(db, 'users', userId, 'workouts'));
  const workouts = {};
  wSnap.forEach((d) => { workouts[d.id] = d.data(); });
  return { ...metaSnap.data(), workouts };
}

// Sube todos los datos (primera vez o tras fusionar).
export async function uploadAll(userId, data) {
  const ops = [['meta', null]];
  for (const k of Object.keys(data.workouts)) ops.push(['w', k]);
  for (let i = 0; i < ops.length; i += 400) {
    const batch = fb.writeBatch(db);
    for (const [type, k] of ops.slice(i, i + 400)) {
      if (type === 'meta') batch.set(fb.doc(db, 'users', userId), metaOf(data));
      else batch.set(fb.doc(db, 'users', userId, 'workouts', k), data.workouts[k]);
    }
    await batch.commit();
  }
}

/* ---------- Sincronización continua ---------- */

export function startSync(userId, dataGetter, onRemote) {
  uid = userId;
  getData = dataGetter;
  setBaseline(getData());

  unsubs.push(fb.onSnapshot(fb.doc(db, 'users', uid), (snap) => {
    if (snap.metadata.hasPendingWrites || timer || !snap.exists()) return;
    const d = getData();
    const remote = snap.data();
    if (JSON.stringify(metaOf(remote)) === lastMeta) return;
    d.groups = remote.groups || d.groups;
    d.exercises = remote.exercises || [];
    d.settings = Object.assign({}, d.settings, remote.settings || {});
    lastMeta = metaStr(d);
    onRemote();
  }));

  let reconciled = false;
  unsubs.push(fb.onSnapshot(fb.collection(db, 'users', uid, 'workouts'), (snap) => {
    if (timer) return;
    const d = getData();
    let changed = false;
    if (!reconciled && !snap.metadata.fromCache) {
      // Primera respuesta del servidor: quitar días borrados desde otro dispositivo.
      reconciled = true;
      const ids = new Set(snap.docs.map((x) => x.id));
      for (const k of Object.keys(d.workouts)) {
        if (!ids.has(k) && lastW[k] === JSON.stringify(d.workouts[k])) { delete d.workouts[k]; delete lastW[k]; changed = true; }
      }
    }
    snap.docChanges().forEach((ch) => {
      if (ch.doc.metadata.hasPendingWrites) return;
      const k = ch.doc.id;
      if (ch.type === 'removed') {
        if (d.workouts[k]) { delete d.workouts[k]; changed = true; }
        delete lastW[k];
      } else {
        const w = ch.doc.data();
        const s = JSON.stringify(w);
        if (lastW[k] !== s) { d.workouts[k] = w; lastW[k] = s; changed = true; }
      }
    });
    if (changed) onRemote();
  }));
}

export function stopSync() {
  unsubs.forEach((u) => u());
  unsubs = [];
  uid = null;
  clearTimeout(timer); timer = null;
}

export function setBaseline(d) {
  lastMeta = metaStr(d);
  lastW = {};
  for (const k of Object.keys(d.workouts)) lastW[k] = JSON.stringify(d.workouts[k]);
}

// Se llama en cada guardado; agrupa los cambios y los sube pasado un momento.
export function queuePush() {
  if (!uid) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 700);
}

export async function flush() {
  clearTimeout(timer); timer = null;
  if (!uid) return;
  const d = getData();
  const batch = fb.writeBatch(db);
  let n = 0;
  const ms = metaStr(d);
  if (ms !== lastMeta) { batch.set(fb.doc(db, 'users', uid), metaOf(d)); lastMeta = ms; n++; }
  for (const k of Object.keys(d.workouts)) {
    const s = JSON.stringify(d.workouts[k]);
    if (lastW[k] !== s) { batch.set(fb.doc(db, 'users', uid, 'workouts', k), d.workouts[k]); lastW[k] = s; n++; }
  }
  for (const k of Object.keys(lastW)) {
    if (!d.workouts[k]) { batch.delete(fb.doc(db, 'users', uid, 'workouts', k)); delete lastW[k]; n++; }
  }
  if (n) batch.commit().catch((e) => console.error('sync', e));
}
