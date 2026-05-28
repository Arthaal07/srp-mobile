/**
 * SRP Phase 1 — Serveur complet avec WebSocket temps réel
 * Multi-rôles : Opérateur / Niveau 1-2 / Niveau 3
 */
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('./node_modules/ws');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');
const QRCode = require('qrcode');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// WebSocket Server
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map(); // socketId -> { ws, role, name, remonteeId }

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2);
  clients.set(id, { ws, role: null, name: null });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWS(id, msg);
    } catch(e) {}
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ type: 'presence', clients: getPresence() });
  });

  ws.on('error', () => clients.delete(id));

  // Envoyer l'ID au client
  ws.send(JSON.stringify({ type: 'connected', id }));
});

function handleWS(id, msg) {
  const client = clients.get(id);
  if (!client) return;

  switch(msg.type) {
    case 'identify':
      client.role = msg.role;
      client.name = msg.name;
      broadcast({ type: 'presence', clients: getPresence() });
      break;

    case 'comment':
      if (!msg.remonteeId || !msg.text) return;
      try {
        dbRun(`INSERT INTO commentaires (remontee_id, auteur, role, texte) VALUES (?,?,?,?)`,
          [msg.remonteeId, client.name || 'Inconnu', client.role || '0', msg.text]);
        const comment = {
          id: dbGet('SELECT last_insert_rowid() as id')?.id,
          remontee_id: msg.remonteeId,
          auteur: client.name,
          role: client.role,
          texte: msg.text,
          created_at: new Date().toISOString()
        };
        broadcast({ type: 'comment', comment });
      } catch(e) { console.error('comment:', e.message); }
      break;

    case 'typing':
      broadcastExcept(id, { type: 'typing', remonteeId: msg.remonteeId, name: client.name });
      break;

    case 'watch':
      client.remonteeId = msg.remonteeId;
      break;
  }
}

function getPresence() {
  const p = [];
  clients.forEach(c => { if (c.name) p.push({ name: c.name, role: c.role }); });
  return p;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg); });
}

function broadcastExcept(excludeId, data) {
  const msg = JSON.stringify(data);
  clients.forEach((c, id) => {
    if (id !== excludeId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  });
}

function broadcastToRoles(roles, data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => {
    if (roles.includes(c.role) && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  });
}

// ─── DB SETUP ─────────────────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'remontees.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS remontees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      operateur TEXT NOT NULL, poste TEXT NOT NULL,
      categorie TEXT NOT NULL, urgence TEXT DEFAULT 'Normal',
      description TEXT NOT NULL,
      photo_b64 TEXT, croquis_b64 TEXT, annotation_b64 TEXT, photo_check_b64 TEXT,
      frequence TEXT, impact TEXT, perimetre TEXT, recurrent INTEGER DEFAULT 0,
      proposition_operateur TEXT, infos_utiles TEXT,
      analyse_5p TEXT, analyse_ishikawa TEXT, analyse_isnot TEXT,
      analyse_qqoqccp TEXT, analyse_8d TEXT,
      statut TEXT DEFAULT 'Nouveau', niveau_actuel INTEGER DEFAULT 1,
      date_escalade_n2 TEXT, traitement_n1 TEXT, traitement_n2 TEXT,
      contre_mesure_retenue TEXT, responsable_do TEXT,
      date_test_debut TEXT, date_check TEXT,
      resultat_check TEXT, photo_check_b64_val TEXT,
      standard_cree TEXT, lecon_apprise TEXT,
      date_cloture TEXT, delai_resolution_h REAL
    );

    CREATE TABLE IF NOT EXISTS historique_statuts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remontee_id INTEGER, ancien_statut TEXT, nouveau_statut TEXT,
      niveau INTEGER, user_label TEXT, commentaire TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS commentaires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remontee_id INTEGER NOT NULL, auteur TEXT, role TEXT,
      texte TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS config (
      cle TEXT PRIMARY KEY, valeur TEXT,
      modifie_le TEXT DEFAULT (datetime('now','localtime'))
    );

    INSERT OR IGNORE INTO config (cle, valeur) VALUES
      ('delai_escalade_normal_h','72'),
      ('delai_escalade_urgent_h','24'),
      ('delai_escalade_critique_h','4'),
      ('postes','["Poste A1","Poste A2","Poste B1","Poste B2","Ligne 1","Ligne 2","Montage","Contrôle","Expédition","Maintenance"]'),
      ('categories','["Qualité","Sécurité","Machine","Flux","Conditions","Autre"]');
  `);

  saveDB();
  console.log('✅ DB prête');
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); } catch(e) {}
}
setInterval(saveDB, 20000);

function dbAll(sql, p = []) {
  try {
    const s = db.prepare(sql); s.bind(p);
    const rows = [];
    while (s.step()) rows.push(s.getAsObject());
    s.free(); return rows;
  } catch(e) { return []; }
}
function dbGet(sql, p = []) { return dbAll(sql, p)[0] || null; }
function dbRun(sql, p = []) {
  db.run(sql, p); saveDB();
  const r = db.exec('SELECT last_insert_rowid() as id');
  return { lastInsertRowid: r[0]?.values[0][0] };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8*1024*1024 } });
const toB64 = f => f ? `data:${f.mimetype};base64,${f.buffer.toString('base64')}` : null;

// ─── API CONFIG ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = {};
  dbAll('SELECT cle, valeur FROM config').forEach(r => {
    try { cfg[r.cle] = JSON.parse(r.valeur); } catch { cfg[r.cle] = r.valeur; }
  });
  res.json(cfg);
});

app.patch('/api/config/:cle', (req, res) => {
  const v = typeof req.body.valeur === 'object' ? JSON.stringify(req.body.valeur) : String(req.body.valeur);
  dbRun('INSERT OR REPLACE INTO config (cle,valeur) VALUES (?,?)', [req.params.cle, v]);
  res.json({ ok: true });
});

// ─── API REMONTÉES ────────────────────────────────────────────────────────────
app.post('/api/remontees',
  upload.fields([{name:'photo',max:3},{name:'croquis',max:1},{name:'annotation',max:1}]),
  (req, res) => {
    try {
      const d = req.body, f = req.files || {};

      // Validation champs obligatoires
      if (!d.operateur?.trim()) return res.status(400).json({ error: 'Opérateur manquant' });
      if (!d.poste?.trim())     return res.status(400).json({ error: 'Poste manquant' });
      if (!d.description?.trim()) return res.status(400).json({ error: 'Description manquante' });

      const result = dbRun(`
        INSERT INTO remontees (operateur,poste,categorie,urgence,description,
          photo_b64,croquis_b64,annotation_b64,frequence,impact,perimetre,recurrent,
          proposition_operateur,infos_utiles,analyse_5p,statut,niveau_actuel)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        d.operateur.trim(), d.poste.trim(),
        d.categorie||'Autre', d.urgence||'Normal', d.description.trim(),
        f.photo?.[0] ? toB64(f.photo[0]) : null,
        f.croquis?.[0] ? toB64(f.croquis[0]) : null,
        f.annotation?.[0] ? toB64(f.annotation[0]) : null,
        d.frequence||null, d.impact||null, d.perimetre||null,
        d.recurrent==='true'?1:0,
        d.proposition_operateur||null, d.infos_utiles||null, d.analyse_5p||null,
        'Nouveau', 1
      ]);

      const id = result.lastInsertRowid;

      // id peut être 0 (première remontée) — on vérifie avec !== undefined
      if (id === undefined || id === null) {
        return res.status(500).json({ error: 'Erreur insertion base de données' });
      }

      dbRun('INSERT INTO historique_statuts (remontee_id,nouveau_statut,niveau,user_label) VALUES (?,?,?,?)',
        [id, 'Nouveau', 1, d.operateur]);

      broadcastToRoles(['1','2','3'], {
        type: 'nouvelle_remontee',
        id, urgence: d.urgence, poste: d.poste,
        operateur: d.operateur, description: d.description
      });
      if (d.urgence === 'Critique') broadcast({
        type: 'alerte_critique', id, poste: d.poste, operateur: d.operateur
      });

      // Retourner success avec id explicitement converti
      res.json({ id: Number(id), statut: 'Nouveau', ok: true });

    } catch(e) {
      console.error('POST /remontees error:', e.message);
      res.status(500).json({ error: e.message || 'Erreur serveur' });
    }
  }
);

app.get('/api/remontees', (req, res) => {
  let sql = `SELECT id,created_at,updated_at,operateur,poste,categorie,urgence,description,
    frequence,impact,perimetre,recurrent,proposition_operateur,infos_utiles,
    analyse_5p,analyse_ishikawa,analyse_isnot,analyse_qqoqccp,analyse_8d,
    statut,niveau_actuel,date_escalade_n2,traitement_n1,traitement_n2,
    contre_mesure_retenue,responsable_do,date_test_debut,date_check,
    resultat_check,standard_cree,lecon_apprise,date_cloture,delai_resolution_h
    FROM remontees WHERE 1=1`;
  const p = [];
  if (req.query.statut)    { sql += ' AND statut=?';    p.push(req.query.statut); }
  if (req.query.urgence)   { sql += ' AND urgence=?';   p.push(req.query.urgence); }
  if (req.query.categorie) { sql += ' AND categorie=?'; p.push(req.query.categorie); }
  if (req.query.poste)     { sql += ' AND poste=?';     p.push(req.query.poste); }
  if (req.query.operateur) { sql += ' AND operateur=?'; p.push(req.query.operateur); }
  if (req.query.ouvert==='true') sql += " AND statut NOT IN ('Résolu','Clôturé')";
  sql += ' ORDER BY created_at DESC';
  if (req.query.limit) { sql += ' LIMIT ?'; p.push(+req.query.limit); }
  res.json(dbAll(sql, p));
});

app.get('/api/remontees/:id', (req, res) => {
  const r = dbGet('SELECT * FROM remontees WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Non trouvé' });
  const hist = dbAll('SELECT * FROM historique_statuts WHERE remontee_id=? ORDER BY created_at', [req.params.id]);
  const comments = dbAll('SELECT * FROM commentaires WHERE remontee_id=? ORDER BY created_at', [req.params.id]);
  res.json({ ...r, historique: hist, commentaires: comments });
});

app.patch('/api/remontees/:id',
  upload.fields([{name:'photo_check',max:1}]),
  (req, res) => {
    const id = req.params.id;
    const r = dbGet('SELECT statut,niveau_actuel FROM remontees WHERE id=?', [id]);
    if (!r) return res.status(404).json({ error: 'Non trouvé' });

    const d = req.body, f = req.files || {};
    const now = new Date().toISOString();
    const updates = { updated_at: now };

    const fields = ['statut','niveau_actuel','traitement_n1','traitement_n2',
      'contre_mesure_retenue','responsable_do','date_test_debut','date_check',
      'resultat_check','standard_cree','lecon_apprise',
      'analyse_5p','analyse_ishikawa','analyse_isnot','analyse_qqoqccp','analyse_8d',
      'proposition_operateur','infos_utiles'];
    fields.forEach(k => { if (d[k] !== undefined && d[k] !== '') updates[k] = d[k]; });

    if (f.photo_check?.[0]) updates.photo_check_b64 = toB64(f.photo_check[0]);

    if (['Clôturé','Résolu'].includes(d.statut)) {
      updates.date_cloture = now;
      const c = dbGet('SELECT created_at FROM remontees WHERE id=?', [id]);
      updates.delai_resolution_h = Math.round(((Date.now()-new Date(c.created_at).getTime())/3600000)*10)/10;
    }

    const cols = Object.keys(updates).map(k=>`${k}=?`).join(',');
    dbRun(`UPDATE remontees SET ${cols} WHERE id=?`, [...Object.values(updates), id]);

    if (d.statut && d.statut !== r.statut) {
      dbRun('INSERT INTO historique_statuts (remontee_id,ancien_statut,nouveau_statut,niveau,user_label,commentaire) VALUES (?,?,?,?,?,?)',
        [id, r.statut, d.statut, d.niveau_actuel||r.niveau_actuel, d.user_label||null, d.commentaire||null]);
    }

    // Notifier tous les connectés sur cette fiche
    const updated = dbGet(`SELECT id,statut,niveau_actuel,contre_mesure_retenue,resultat_check,lecon_apprise,date_cloture FROM remontees WHERE id=?`, [id]);
    broadcast({ type: 'remontee_updated', remontee: updated });

    res.json({ ok: true });
  }
);

// ─── COMMENTAIRES ─────────────────────────────────────────────────────────────
app.get('/api/remontees/:id/commentaires', (req, res) => {
  res.json(dbAll('SELECT * FROM commentaires WHERE remontee_id=? ORDER BY created_at', [req.params.id]));
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const total = dbGet("SELECT COUNT(*) as n FROM remontees")?.n||0;
  const ouverts = dbGet("SELECT COUNT(*) as n FROM remontees WHERE statut NOT IN ('Résolu','Clôturé')")?.n||0;
  const resolus = dbGet("SELECT COUNT(*) as n FROM remontees WHERE statut IN ('Résolu','Clôturé')")?.n||0;
  const critiques_ouverts = dbGet("SELECT COUNT(*) as n FROM remontees WHERE urgence='Critique' AND statut NOT IN ('Résolu','Clôturé')")?.n||0;
  const en_attente_n1 = dbGet("SELECT COUNT(*) as n FROM remontees WHERE niveau_actuel=1 AND statut NOT IN ('Résolu','Clôturé')")?.n||0;
  const en_attente_n2 = dbGet("SELECT COUNT(*) as n FROM remontees WHERE niveau_actuel=2 AND statut NOT IN ('Résolu','Clôturé')")?.n||0;
  const mttr = dbGet("SELECT AVG(delai_resolution_h) as v FROM remontees WHERE delai_resolution_h IS NOT NULL")?.v;
  const taux = total>0?Math.round(resolus/total*100):0;
  const parCategorie = dbAll("SELECT categorie,COUNT(*) as n FROM remontees GROUP BY categorie ORDER BY n DESC");
  const parUrgence = dbAll("SELECT urgence,COUNT(*) as n FROM remontees GROUP BY urgence ORDER BY n DESC");
  const top5 = dbAll("SELECT id,operateur,poste,categorie,urgence,description,created_at,statut FROM remontees WHERE statut NOT IN ('Résolu','Clôturé') ORDER BY created_at ASC LIMIT 5");
  const recents = dbAll("SELECT id,created_at,operateur,poste,categorie,urgence,description,statut,niveau_actuel FROM remontees ORDER BY created_at DESC LIMIT 15");
  const evolution = dbAll("SELECT substr(created_at,1,7) as mois,COUNT(*) as soumises,SUM(CASE WHEN statut IN ('Résolu','Clôturé') THEN 1 ELSE 0 END) as resolues FROM remontees GROUP BY mois ORDER BY mois DESC LIMIT 6").reverse();
  const connectedClients = getPresence().length;
  res.json({total,ouverts,resolus,critiques_ouverts,en_attente_n1,en_attente_n2,
    mttr:mttr?Math.round(mttr*10)/10:null,taux,parCategorie,parUrgence,top5,recents,evolution,connectedClients});
});

app.get('/api/export/csv', (req, res) => {
  const rows = dbAll('SELECT id,created_at,operateur,poste,categorie,urgence,description,frequence,impact,perimetre,recurrent,statut,niveau_actuel,contre_mesure_retenue,resultat_check,standard_cree,lecon_apprise,date_cloture,delai_resolution_h FROM remontees ORDER BY created_at DESC');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition',`attachment;filename="srp-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+stringify(rows,{header:true}));
});

app.get('/api/qrcode', async (req, res) => {
  const base = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
  const qr = await QRCode.toDataURL(base, {width:300,margin:2});
  res.json({ url:base, qr });
});

app.get('/health', (req, res) => res.json({status:'ok',uptime:process.uptime(),connected:clients.size}));

// ─── ESCALADE AUTO ────────────────────────────────────────────────────────────
function runEscalade() {
  const get = k => parseFloat(dbGet('SELECT valeur FROM config WHERE cle=?',[k])?.valeur||72);
  const delais = { Critique: get('delai_escalade_critique_h'), Urgent: get('delai_escalade_urgent_h'), Normal: get('delai_escalade_normal_h') };
  dbAll("SELECT id,urgence,created_at FROM remontees WHERE statut NOT IN ('Résolu','Clôturé') AND niveau_actuel=1")
    .forEach(r => {
      if ((Date.now()-new Date(r.created_at).getTime())/3600000 >= (delais[r.urgence]||72)) {
        const ts = new Date().toISOString();
        dbRun('UPDATE remontees SET niveau_actuel=2,date_escalade_n2=?,updated_at=? WHERE id=?',[ts,ts,r.id]);
        dbRun('INSERT INTO historique_statuts (remontee_id,ancien_statut,nouveau_statut,niveau,commentaire) VALUES (?,?,?,?,?)',
          [r.id,'En cours','Escaladé',2,'Escalade automatique']);
        broadcastToRoles(['2','3'],{type:'escalade',id:r.id});
      }
    });
}
setInterval(runEscalade, 3600000);

// ─── ROUTES SPA ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({error:'Not found'});
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  runEscalade();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏭 SRP démarré — port ${PORT}`);
    console.log(`📱 App : http://localhost:${PORT}`);
    if (process.env.RAILWAY_PUBLIC_DOMAIN) console.log(`🌐 https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  });
});
