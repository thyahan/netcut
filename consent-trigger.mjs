// Cut the phone's network the moment the customer taps consent (/sessions/{id}/consent_at is written).
// Read-only on staging RTDB (profile `uat` = true-videocall-staging) — never production.
// Credentials copied from video-call-devtools: credentials/uat/service-account.json + .env.firebase.
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SA = join(DIR, 'credentials/uat/service-account.json');
const ENV = join(DIR, '.env.firebase');

const sessions = new Map(); // id -> { id, status, consentAt, agentId, createdAt }
let armed = null; // { sessionId, opts, armedAt, ref, handler }
let lastResult = null; // { sessionId, text, at }
let ready = false;
let initError = null;
let onCut = async () => {};

function readEnv() {
  const env = {};
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function db() {
  let app = getApps().find((a) => a.name === 'uat');
  if (!app) {
    const env = readEnv();
    app = initializeApp(
      {
        credential: cert(JSON.parse(readFileSync(SA, 'utf8'))),
        projectId: env.FIREBASE_UAT_PROJECT_ID,
        databaseURL: env.FIREBASE_UAT_DATABASE_URL,
      },
      'uat'
    );
  }
  return getDatabase(app);
}

function toRow(id, v) {
  return {
    id,
    status: v?.status ?? '',
    consentAt: typeof v?.consent_at === 'number' ? v.consent_at : null,
    agentId: v?.agent_id ?? '',
    createdAt: typeof v?.created_at === 'number' ? v.created_at : null,
  };
}

/** Start mirroring /sessions. `cut(opts)` performs the phone cut and returns the run result. */
export function startConsentTrigger(cut) {
  onCut = cut;
  if (!existsSync(SA) || !existsSync(ENV)) {
    initError = 'ไม่มี credentials/uat/service-account.json หรือ .env.firebase';
    return;
  }
  try {
    const ref = db().ref('sessions');
    ref.on('child_added', (s) => sessions.set(s.key, toRow(s.key, s.val())));
    ref.on('child_changed', (s) => sessions.set(s.key, toRow(s.key, s.val())));
    ref.on('child_removed', (s) => {
      sessions.delete(s.key);
      if (armed?.sessionId === s.key) {
        lastResult = { sessionId: s.key, text: 'session ถูกลบก่อนลูกค้ากด consent — ยกเลิก ไม่ได้ตัด', at: Date.now() };
        disarm();
      }
    });
    ref.once('value', () => (ready = true), (e) => (initError = e.message));
  } catch (e) {
    initError = e.message;
  }
}

export function arm(sessionId, opts) {
  if (initError) return { ok: false, err: initError };
  const row = sessions.get(sessionId);
  if (!row) return { ok: false, err: `ไม่พบ session ${sessionId}` };
  if (row.consentAt) return { ok: false, err: 'ลูกค้ากด consent ไปแล้ว — ไม่ตัด' };
  disarm();
  const ref = db().ref(`sessions/${sessionId}/consent_at`);
  const handler = async (snap) => {
    const consentAt = snap.val();
    if (typeof consentAt !== 'number' || armed?.sessionId !== sessionId) return;
    const opts = armed.opts;
    disarm();
    const r = await onCut(opts);
    const lag = Date.now() - consentAt;
    lastResult = {
      sessionId,
      target: opts.target,
      text: r.ok ? `ตัดแล้ว +${lag} ms หลัง consent` : `ตัดไม่สำเร็จ (${r.err || r.code})`,
      at: Date.now(),
    };
  };
  armed = { sessionId, opts, armedAt: Date.now(), ref, handler };
  ref.on('value', handler);
  return { ok: true };
}

export function disarm() {
  if (!armed) return;
  armed.ref.off('value', armed.handler);
  armed = null;
}

export function consentState() {
  return {
    ready,
    error: initError,
    armed: armed && { sessionId: armed.sessionId, target: armed.opts.target, autoRestoreSec: armed.opts.autoRestoreSec, armedAt: armed.armedAt },
    last: lastResult,
    sessions: [...sessions.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
  };
}
