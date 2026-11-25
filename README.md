# PersonalDashboard

Supervision auto-hébergée de vos services et serveurs, en deux parties :

| | Page publique `/` | Espace privé `/admin` |
|---|---|---|
| Statut en ligne / hors ligne | ✅ | ✅ |
| Graphique disponibilité + latence (1 h / 24 h / 7 j / 30 j / 1 an) | ✅ | ✅ |
| Disponibilité sur 30 jours et sur 1 an | ✅ | ✅ |
| Clic sur la carte → ouvre le service dans un nouvel onglet | ✅ | bouton « Ouvrir » |
| Cible surveillée, message d'erreur | — | ✅ |
| IP, utilisateur, mot de passe (masqué, affichable, copiable) | — | ✅ |
| Console SSH du serveur dans la carte | — | ✅ |
| Ajouter / modifier / supprimer / tester un service | — | ✅ |
| Notifications Discord (panne / retour) | — | ✅ |

## Types de vérification

| Type | Cible | « En ligne » si… |
|---|---|---|
| **Ping** | IP ou nom d'hôte | réponse ICMP |
| **TCP** | IP ou nom d'hôte + port | le port accepte la connexion |
| **HTTP(S)** | URL `http://` ou `https://` | code HTTP < 400 (certificat TLS valide) |
| **DNS** | IP ou nom d'un **serveur DNS** (+ port, 53 par défaut) | le serveur répond à une requête de test (domaine et type configurables, `example.com A` par défaut). NXDOMAIN compte comme une réponse ; REFUSED, SERVFAIL ou l'absence de réponse comptent comme une panne |

Chaque service est vérifié selon son intervalle (60 s par défaut).

> Pour un serveur DNS **autoritaire** (qui ne fait pas résolveur), choisissez comme domaine de test une zone qu'il héberge : sinon il répondra REFUSED.

## Historique

| Données | Conservation | Utilisées pour |
|---|---|---|
| Chaque vérification (statut, latence, message) | `RETENTION_DAYS` = **30 jours** | graphiques 1 h et 24 h, dernier statut |
| Agrégats horaires (nombre de vérifications, disponibilité, latence moyenne) | `RETENTION_HOURLY_DAYS` = **365 jours** | graphiques 7 j, 30 j et 1 an, disponibilité 30 j et 1 an |

Les données plus anciennes sont supprimées automatiquement toutes les heures. Avec un intervalle de 60 s, un an d'agrégats représente environ 8 760 lignes par service.

Un service peut être marqué **privé** : il n'apparaît alors que dans l'espace privé.

## Notifications Discord

1. Dans Discord : **Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL du webhook**.
2. Dans l'espace privé : bouton **🔔 Notifications**, collez l'URL, cliquez sur **Enregistrer**, puis sur **Envoyer un test**.

Deux messages sont envoyés :

- 🔴 **hors ligne** : quand une panne est confirmée, avec le type, la cible, l'erreur et l'heure de début ;
- 🟢 **de nouveau en ligne** : au premier succès suivant, avec la durée de l'interruption et la latence.

Pour éviter les fausses alertes, une panne n'est annoncée qu'après `ALERT_AFTER_FAILURES` échecs consécutifs (2 par défaut). Après un premier échec, le service est revérifié au bout de `RETRY_SEC` secondes (20 par défaut) : une panne réelle est donc signalée en 20 à 30 secondes environ.

Les notifications se désactivent service par service (case « Notifier sur Discord » dans le formulaire). L'URL du webhook est chiffrée en base. Elle peut aussi être fournie par la variable `DISCORD_WEBHOOK_URL`.

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
  monitor.js   vérifications ping / tcp / http / dns, purge de l'historique
  terminal.js  console SSH via WebSocket (ssh2)
  notify.js    notifications Discord
  db.js        SQLite (data/dashboard.db)
  auth.js      connexion admin, sessions, anti-bruteforce
  crypto.js    chiffrement des mots de passe
public/
  index.html   page publique
  admin.html   espace privé
```

## API

- `GET /api/status?hours=1|24|168|720|8760` : statut public (sans authentification)
- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET|POST /api/admin/services`, `PUT|DELETE /api/admin/services/:id`
- `GET /api/admin/services/:id/password`, `POST /api/admin/services/:id/check`
- `GET|PUT /api/admin/settings`, `POST /api/admin/settings/test-discord` : webhook Discord
- `WS /ws/terminal?id=:id` : console SSH (session admin requise)
