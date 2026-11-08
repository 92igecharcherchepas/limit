# LimitRole

Bot Discord.js v14 qui plafonne le nombre de membres pouvant posséder un rôle.

## Installation

Dans ce dossier, lance `npm install`, puis crée un fichier `.env` :

```env
DISCORD_TOKEN=token_du_bot
BOT_OWNER_ID=id_discord_du_proprietaire_principal
PREFIX=*
```

Active les intents privilégiés **Server Members Intent** et **Message Content Intent** dans le portail Discord. Invite le bot sur le serveur où les rôles sont gérés et sur le serveur de logs. Invite le bot avec les permissions **Manage Roles**, **View Audit Log**, **View Channels** et **Send Messages**. Son rôle doit être placé au-dessus des rôles qu’il gère.

Lancer le bot : `npm start`.

## Commandes

- `*help` ou `*aide` — affiche l’aide des commandes.
- `*limit @rôle nombre` — définit le maximum de membres. Une baisse de limite retire le rôle aux membres les plus récemment arrivés sur le serveur jusqu’à respecter le plafond.
- `*limit remove @rôle` — supprime la limite configurée.
- `*panel` — ouvre un panel avec un menu de rôles, un menu de suppression et un bouton de configuration du salon de logs.
- `*sys` — le propriétaire principal défini par `BOT_OWNER_ID` peut ajouter ou retirer jusqu’à 10 owners à la fois via des menus déroulants.

Dans le panel, clique sur **Configurer le salon de logs** et saisis l’ID ou la mention du salon, même s’il est sur un autre serveur. Laisse le champ vide pour désactiver les logs. Le bot doit être présent sur le serveur de destination et avoir les permissions **Voir le salon** et **Envoyer des messages**. Le salon configuré est sauvegardé par serveur dans `data/settings.json`, pas dans le `.env`.

Les panels, réponses, erreurs et journaux utilisent les composants V2. Lorsqu’un rôle est retiré pour respecter une limite, le journal au format « Super limite : rôle retiré » indique le membre, le rôle, la limite, l’auteur de l’attribution (si disponible dans l’audit log) et le worker qui a retiré le rôle. Le numéro affiché est celui de `WORKER_ID` si défini, sinon celui du shard Discord (ou `0` si le bot n’est pas shardé). Les limites sont sauvegardées dans `data/limits.json` par serveur et les owners dans `data/owners.json`. Les administrateurs et les owners configurés peuvent gérer les rôles; seul `BOT_OWNER_ID` peut modifier la liste des owners.
