/**
 * functions/[[catchall]].js
 * Wedding Video Booth — Cloudflare Pages Function
 *
 * FIXES:
 * 1. Tambah `next()` passthrough agar index.html ter-serve oleh Cloudflare static assets
 * 2. Export onRequestGet + onRequestPost + onRequestOptions secara eksplisit
 * 3. Destruktur `next` dari ctx agar bisa dipanggil untuk non-API routes
 *
 * Google Sheet tab "Entries" — baris 1 header:
 *   A:timestamp  B:name  C:message  D:media_url  E:vn_url  F:drive_id  G:vn_drive_id  H:media_type
 *
 * Env vars (Cloudflare Pages → Settings → Environment Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY    (full PEM, \n boleh literal atau real newline)
 *   GOOGLE_DRIVE_FOLDER_ID
 *   GOOGLE_SHEET_ID
 */

// ── Shared dispatcher ────────────────────────────────────────────────────────
// FIX: Destruktur `next` dari ctx — diperlukan agar static assets (index.html) bisa di-serve
async function dispatch({ request, env, next }) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  try {
    if (method === 'OPTIONS')                              return cors204();
    if (pathname === '/api/submit'  && method === 'POST') return await handleSubmit(request, env);
    if (pathname === '/api/gallery' && method === 'GET')  return await handleGallery(env);
    if (pathname === '/api/debug'   && method === 'GET')  return await handleDebug(env);

    // FIX: Semua request non-API (termasuk "/") di-pass ke Cloudflare static asset handler
    // Ini yang membuat index.html ter-serve dengan benar
    return next();
  } catch (err) {
    console.error('[dispatch]', err);
    return jsonRes({ ok: false, error: err.message, trace: err.stack?.slice(0, 400) }, 500);
  }
}

// FIX 405: Export named handlers — Cloudflare Pages butuh ini agar POST ter-route
export const onRequestGet     = (ctx) => dispatch(ctx);
export const onRequestPost    = (ctx) => dispatch(ctx);
export const onRequestOptions = (ctx) => dispatch(ctx);
// Generic fallback juga disertakan
export const onRequest        = (ctx) => dispatch(ctx);

// ═══════════════════════════════════════════════════════════
// SUBMIT  POST /api/submit
// ═══════════════════════════════════════════════════════════
async function handleSubmit(request, env) {
  let form;
  try { form = await request.formData(); }
  catch (e) { return jsonRes({ ok: false, error: 'FormData error: ' + e.message }, 400); }

  const name      = (form.get('name') || '').trim();
  const message   = (form.get('message') || '').trim();
  const photoFile = form.get('photo');
  const videoFile = form.get('video');
  const vnFile    = form.get('vn');
  const mediaFile = photoFile || videoFile;
  const isPhoto   = !!photoFile;
  const mediaType = isPhoto ? 'photo' : 'video';
  const mediaName = isPhoto ? 'photo.jpg' : 'video.webm';
  const mediaMime = mediaFile?.type || (isPhoto ? 'image/jpeg' : 'video/webm');

  if (!name)      return jsonRes({ ok: false, error: 'Nama wajib diisi' }, 400);
  if (!mediaFile) return jsonRes({ ok: false, error: 'File foto/video tidak ada' }, 400);

  // Auth
  let token;
  try { token = await googleToken(env); }
  catch (e) { return jsonRes({ ok: false, error: 'Google auth gagal: ' + e.message }, 500); }

  // Buat subfolder
  const stamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = name.replace(/[^\w\- ]/g, '_').slice(0, 30);
  const folderId = await driveCreateFolder(token, env.GOOGLE_DRIVE_FOLDER_ID, `${stamp}_${safeName}`);

  // Upload media — resumable agar tidak timeout
  const mediaDriveId = await driveResumableUpload(token, folderId, mediaName, mediaMime, mediaFile);
  const mediaUrl     = driveViewUrl(mediaDriveId);

  // Upload voice note (opsional)
  let vnUrl = '', vnDriveId = '';
  if (vnFile && vnFile.size > 0) {
    const vnMime = vnFile.type || 'audio/webm';
    vnDriveId    = await driveResumableUpload(token, folderId, 'voicenote.webm', vnMime, vnFile);
    vnUrl        = driveViewUrl(vnDriveId);
  }

  // Simpan ke Sheets
  await sheetsAppend(token, env.GOOGLE_SHEET_ID, [
    new Date().toISOString(), name, message,
    mediaUrl, vnUrl, mediaDriveId, vnDriveId, mediaType,
  ]);

  return jsonRes({
    ok: true,
    media_url: mediaUrl, video_url: mediaUrl, photo_url: mediaUrl,
    vn_url: vnUrl, media_type: mediaType,
  });
}

// ═══════════════════════════════════════════════════════════
// GALLERY  GET /api/gallery
// ═══════════════════════════════════════════════════════════
async function handleGallery(env) {
  let token;
  try { token = await googleToken(env); }
  catch (e) { return jsonRes({ ok: false, error: 'Google auth gagal: ' + e.message }, 500); }

  const data = await sheetsRead(token, env.GOOGLE_SHEET_ID, 'Entries!A:H');

  if (!data.values || data.values.length <= 1)
    return jsonRes({ ok: true, entries: [] });

  const entries = data.values.slice(1)
    .filter(r => r[0] && r[3])
    .map(r => ({
      timestamp:  r[0] || '',
      name:       r[1] || 'Tamu',
      message:    r[2] || '',
      video_url:  r[3] || '',
      vn_url:     r[4] || '',
      drive_id:   r[5] || '',
      media_type: r[7] || 'video',
    }))
    .reverse();

  return jsonRes({ ok: true, entries });
}

// ═══════════════════════════════════════════════════════════
// DEBUG  GET /api/debug
// ═══════════════════════════════════════════════════════════
async function handleDebug(env) {
  const r = {
    ts: new Date().toISOString(),
    env_email:  !!env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env_key:    !!env.GOOGLE_PRIVATE_KEY,
    env_folder: !!env.GOOGLE_DRIVE_FOLDER_ID,
    env_sheet:  !!env.GOOGLE_SHEET_ID,
    sheet_id:   env.GOOGLE_SHEET_ID   || '(not set)',
    folder_id:  env.GOOGLE_DRIVE_FOLDER_ID || '(not set)',
  };
  try {
    const t = await googleToken(env);
    r.auth = 'OK';
    const [h, c] = await Promise.all([
      sheetsRead(t, env.GOOGLE_SHEET_ID, 'Entries!A1:H1'),
      sheetsRead(t, env.GOOGLE_SHEET_ID, 'Entries!A:A'),
    ]);
    r.sheet_header = h.values?.[0] ?? '(kosong — cek nama tab)';
    r.row_count    = Math.max(0, (c.values?.length ?? 1) - 1);
  } catch (e) { r.auth = 'FAILED'; r.error = e.message; }
  return jsonRes(r);
}

// ═══════════════════════════════════════════════════════════
// GOOGLE AUTH
// ═══════════════════════════════════════════════════════════
async function googleToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL tidak di-set');
  if (!env.GOOGLE_PRIVATE_KEY)           throw new Error('GOOGLE_PRIVATE_KEY tidak di-set');

  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pem   = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
  const scope = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';
  const now   = Math.floor(Date.now() / 1000);

  const hdr     = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cla     = b64u(JSON.stringify({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signing = `${hdr}.${cla}`;
  const key     = await importRsa(pem);
  const sig     = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, te(signing));
  const jwt     = `${signing}.${b64uBuf(sig)}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token error: ' + JSON.stringify(json));
  return json.access_token;
}

async function importRsa(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', buf.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// ═══════════════════════════════════════════════════════════
// GOOGLE SHEETS
// ═══════════════════════════════════════════════════════════
async function sheetsRead(token, sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Sheets read ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

async function sheetsAppend(token, sheetId, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Entries!A:H:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Sheets append ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

// ═══════════════════════════════════════════════════════════
// GOOGLE DRIVE
// ═══════════════════════════════════════════════════════════
async function driveCreateFolder(token, parentId, name) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Drive mkdir ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt).id;
}

// Resumable upload — stream langsung, tidak buffer di Worker memory
async function driveResumableUpload(token, folderId, filename, mimeType, file) {
  // Step 1: Initiate — dapatkan upload session URI
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization:             `Bearer ${token}`,
        'Content-Type':            'application/json; charset=UTF-8',
        'X-Upload-Content-Type':   mimeType,
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ name: filename, parents: [folderId] }),
    }
  );
  if (!initRes.ok) {
    const t = await initRes.text();
    throw new Error(`Drive init ${initRes.status}: ${t.slice(0, 200)}`);
  }
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Drive: Location header kosong setelah initiate');

  // Step 2: Upload — stream file body ke URI (tidak di-buffer di Worker)
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(file.size) },
    body: file.stream(),
    // @ts-ignore — Cloudflare Workers support streaming body
    duplex: 'half',
  });
  const uploadTxt = await uploadRes.text();
  if (!uploadRes.ok) throw new Error(`Drive upload ${uploadRes.status}: ${uploadTxt.slice(0, 200)}`);
  const { id } = JSON.parse(uploadTxt);

  // Step 3: Set public permission
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!permRes.ok) console.warn(`Drive perm ${id}: ${permRes.status}`);

  return id;
}

function driveViewUrl(id) {
  if (!id) return '';
  return `https://drive.google.com/uc?export=view&id=${id}`;
}

// ═══════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════
function cors204() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
function b64u(s)    { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function b64uBuf(b) { return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function te(s)      { return new TextEncoder().encode(s); }
