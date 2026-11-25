# PersonalDashboard

Supervision auto-hébergée de vos services et serveurs, en deux parties :

| | Page publique `/` | Espace privé `/admin` |
|---|---|---|
| Statut en ligne / hors ligne | ✅ | ✅ |
| Graphique disponibilité + latence (1 h / 24 h / 7 j) | ✅ | ✅ |
| Clic sur la carte → ouvre le service dans un nouvel onglet | ✅ | bouton « Ouvrir » |
| Cible surveillée, message d'erreur | — | ✅ |
| IP, utilisateur, mot de passe (masqué, affichable, copiable) | — | ✅ |
| Console SSH du serveur dans la carte | — | ✅ |
| Ajouter / modifier / supprimer / tester un service | — | ✅ |

## Types de vérification

| Type | Cible | « En ligne » si… |
|---|---|---|
| **Ping** | IP ou nom d'hôte | réponse ICMP |
| **TCP** | IP ou nom d'hôte + port | le port accepte la connexion |
| **HTTP(S)** | URL `http://` ou `https://` | code HTTP < 400 (certificat TLS valide) |
| **DNS** | nom de domaine (+ type A, AAAA, MX, TXT…, valeur attendue et serveur DNS facultatifs) | la résolution réussit et contient la valeur attendue |

Chaque service est vérifié selon son intervalle (60 s par défaut). L'historique est conservé `RETENTION_DAYS` jours (30 par défaut).

Un service peut être marqué **privé** : il n'apparaît alors que dans l'espace privé.

## Installation

### Avec Docker (recommandé)

```bash
cp .env.example .env
# Éditez .env : ADMIN_PASSWORD et MASTER_KEY (openssl rand -hex 32)
docker compose up -d --build
```

### Sans Docker (Node.js 22+)

```bash
npm ci
cp .env.example .env   # puis éditez-le
npm start
```

Le tableau de bord écoute sur http://localhost:3000. L'espace privé est sur `/admin`.

> Le type **Ping** utilise la commande système `ping` : elle est incluse dans l'image Docker. Sans Docker, installez `iputils-ping` si elle est absente.

## Sécurité : à lire

Cet outil stocke des accès **root** et ouvre des consoles sur vos serveurs. En conséquence :

- **Mettez-le derrière HTTPS** (Caddy, Nginx, Traefik…), puis définissez `COOKIE_SECURE=true` et `TRUST_PROXY=true`. Sans HTTPS, les mots de passe circulent en clair sur le réseau.
- Les mots de passe SSH sont **chiffrés en AES-256-GCM** avec une clé dérivée de `MASTER_KEY`. **Sauvegardez cette clé** : si vous la perdez, tous les mots de passe enregistrés deviennent illisibles. Ne la commitez jamais.
- Choisissez un `ADMIN_PASSWORD` long : 12 caractères au minimum sont exigés.
- Les tentatives de connexion sont limitées à 10 échecs par IP sur 15 minutes. La session expire au bout de `SESSION_HOURS` heures.
- Chaque ouverture de console et chaque affichage de mot de passe est journalisé dans les logs du conteneur.
- Clé d'hôte SSH : l'empreinte du serveur est mémorisée à la première connexion (comme `known_hosts`). Si elle change ensuite, la connexion est **refusée**. Si le changement est légitime (serveur réinstallé), cochez « Réinitialiser l'empreinte SSH » dans l'édition du service.
- La page publique n'expose ni les IP, ni les cibles, ni les messages d'erreur : seulement le nom, le statut, le graphique et le lien.
- Si possible, créez sur vos serveurs un utilisateur dédié avec `sudo` plutôt que d'autoriser la connexion SSH root par mot de passe.

## Structure

```
server/
  index.js     API REST + fichiers statiques
  monitor.js   vérifications ping / tcp / http / dns
  terminal.js  console SSH via WebSocket (ssh2)
  db.js        SQLite (data/dashboard.db)
  auth.js      connexion admin, sessions, anti-bruteforce
  crypto.js    chiffrement des mots de passe
public/
  index.html   page publique
  admin.html   espace privé
```

## API

- `GET /api/status?hours=1|24|168` : statut public (sans authentification)
- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET|POST /api/admin/services`, `PUT|DELETE /api/admin/services/:id`
- `GET /api/admin/services/:id/password`, `POST /api/admin/services/:id/check`
- `WS /ws/terminal?id=:id` : console SSH (session admin requise)
