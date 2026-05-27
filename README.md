# SRP Phase 1 — Système PDCA de Remontée de Problèmes

## Déploiement Railway (5 min)

### 1. Créer un compte GitHub
Si pas encore fait : https://github.com/signup

### 2. Mettre le code sur GitHub
```bash
git init
git add .
git commit -m "SRP Phase 1 initial"
git branch -M main
git remote add origin https://github.com/TON_USER/srp-phase1.git
git push -u origin main
```

### 3. Déployer sur Railway
1. Aller sur https://railway.app → **Start a New Project**
2. Choisir **Deploy from GitHub repo**
3. Connecter ton compte GitHub si demandé
4. Sélectionner le repo `srp-phase1`
5. Railway détecte Node.js automatiquement → cliquer **Deploy**
6. Attendre ~2 minutes que le build finisse
7. Aller dans **Settings → Networking → Generate Domain**
8. Railway te donne une URL `https://srp-phase1-xxx.railway.app`

### 4. Ajouter un volume persistant (important !)
Sans volume, la base de données est perdue à chaque redéploiement.

Dans Railway → ton service → **Volumes** → **Add Volume** :
- Mount path : `/data`
- C'est tout — Railway gère le reste

### 5. Accéder à l'application
| Interface | URL |
|---|---|
| PWA Opérateur (mobile) | `https://ton-app.railway.app` |
| Dashboard Responsable | `https://ton-app.railway.app/dashboard` |
| QR Code postes | `https://ton-app.railway.app/api/qrcode` |

---

## Structure du projet

```
srp-phase1/
├── server.js          → Serveur Express + sql.js
├── public/
│   ├── index.html     → PWA opérateur (mobile)
│   └── dashboard.html → Dashboard responsable AC
├── railway.json       → Config déploiement Railway
├── package.json
└── .gitignore
```

## Lancer en local

```bash
npm install
node server.js
# → http://localhost:3000 (opérateur)
# → http://localhost:3000/dashboard (responsable)
```

## Cycle PDCA — 3 niveaux d'accès

| Niveau | Profil | Accès | Rôle |
|---|---|---|---|
| 0 — Opérateur | Terrain | PWA mobile | Étapes 1, 2, 3 — soumet et suit |
| 1/2 — Encadrement | Chef équipe, Méthode, Qualité | Dashboard | Traite DO (4) et CHECK (5) |
| 3 — Responsable AC | Admin | Dashboard | Valide ACT (6), clôture, config |

## Outils d'analyse intégrés

- **5 Pourquoi** — formulaire guidé dans le formulaire opérateur
- **Panel actions** — contre-mesure, CHECK, ACT, escalade manuelle dans le dashboard
- **Base de connaissance** — leçons apprises recherchables
- **Statistiques** — MTTR, Pareto catégories, récurrences, évolution mensuelle

## Stockage photos

Les photos, croquis et annotations sont convertis en base64 et stockés directement dans SQLite.  
Pas de service externe requis. Limite recommandée : 1 photo par remontée, max 2MB.

## Sauvegarde

- La DB est dans le volume `/data` sur Railway → persistante entre redéploiements
- Export CSV depuis le dashboard → bouton "Export CSV"
- Pour une sauvegarde manuelle : Railway → volume → télécharger `remontees.db`
