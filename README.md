# Clock — Studio Katra

Application web de suivi du temps : une minuterie par personne, description des
tâches, historique quotidien et correction des durées avant export. Interface en
français, adaptée aux ordinateurs et aux mobiles.

## Application Mac personnelle

La version personnelle est dans `desktop/`. Lancer `npm run build:mac` pour
préparer l’archive d’installation. Lire [les instructions Mac](desktop/mac/LIRE-EN-PREMIER.txt).
Elle crée localement `Katra Clock.app` pour macOS 13.5+, sans compte Apple
Developer, et ouvre l’interface dans le navigateur habituel. Elle n’utilise ni
Google ni hébergement, et conserve les accès API dans le Trousseau macOS.
Le mode web conserve sa connexion Google et n’active jamais ce mode personnel
par une variable d’environnement. Le serveur personnel écoute seulement sur
127.0.0.1, avec une clé d’ouverture à usage unique, des cookies HttpOnly et un
contrôle d’origine/CSRF. Les données personnelles sont séparées des essais et
du serveur web dans `~/Library/Application Support/Katra Clock/data`.

L’installateur détecte Intel/Apple Silicon, télécharge Node.js 24.22.2 depuis
nodejs.org et vérifie le SHA-256 officiel avant utilisation. Les dépendances
utilisent le lockfile npm, sans scripts d’installation. AppleScript et la
signature locale ad hoc sont produits par les outils macOS, sans Xcode ni
abonnement Apple. Il ne s’agit pas d’une app notariée ou distribuée via l’App
Store. L’installation et le vrai Trousseau restent à valider sur le Mac de
l’utilisateur ; les tests Linux utilisent un Trousseau simulé.

## Mise en ligne préparée

Le fichier `render.yaml` prépare le déploiement sur Render avec un disque
persistant, sans secret dans le dépôt et sans mises à jour automatiques.
Suivre [le guide de déploiement](docs/deploiement-render.md). La création du
service, le coût affiché par Render et les réglages de domaine et de Google
restent à valider dans vos comptes. Aucun hébergement n’est créé par GitHub.

## État de cette version

- Le parcours local fonctionne avec des projets fictifs en mode démonstration.
- Le parcours OAuth Google est implémenté. Le serveur vérifie le jeton Google,
  son audience, son nonce, le domaine Workspace `hd`, l’adresse vérifiée et le
  domaine exact `studio-katra.com`. Il faut encore fournir les identifiants OAuth
  pour vérifier une connexion réelle.
- L’intégration API v2 Furious est implémentée d’après le PDF `html_print.pdf`
  fourni par l’administrateur. Elle lit les projets actifs, retrouve le
  collaborateur par son email Google, convertit les secondes en fractions de
  journée et crée les temps. Elle exige encore les identifiants du compte API
  et l’accès réseau pour être vérifiée sur l’instance réelle.
- Aucun temps n’est envoyé à Furious en mode démonstration. L’export reste
  désactivé dans l’interface tant que le fournisseur réel n’est pas configuré.
- Cette version n’est pas déployée. Les tests OAuth utilisent un fournisseur de
  test ; les tests d’export utilisent des réponses simulées.

## Essayer localement

Prérequis : **Node.js 24 ou supérieur**, npm. Aucun service de base de données
externe n’est requis. Les tâches cloud sont déjà isolées : utiliser le dépôt
existant `/workspace/clock`, sans créer de worktree Git.

```sh
cd /workspace/clock
npm ci
npm run demo
```

Le mode démonstration écoute uniquement sur l’interface locale, au port 3000 par
défaut. Cliquer sur « Explorer la démonstration » pour essayer le suivi du temps.
Ses données sont séparées dans `data/demo.sqlite`. Ce mode est interdit lorsque
`NODE_ENV=production`.

Pour démarrer la version normale :

```sh
cd /workspace/clock
npm start
```

Sans configuration Google, la page de connexion s’affiche mais aucun accès aux
données ni connexion de démonstration n’est autorisé.

Les processus ne survivent pas nécessairement à la restauration d’un
environnement cloud ; les relancer après restauration. Les dépendances installées
et les fichiers SQLite peuvent être conservés dans le snapshot de la machine.

## Configurer Google Workspace

L’administrateur du studio doit créer un **client OAuth de type application web**
dans Google Cloud, configurer l’écran de consentement pour l’organisation et
enregistrer l’URI de redirection exacte :

```text
https://ADRESSE-PUBLIQUE-DE-CLOCK/auth/google/callback
```

Pour un essai local, Google permet aussi
`http://localhost:3000/auth/google/callback`. Choisir les autorisations minimales
`openid`, `email`, `profile`. Aucune autorisation Gmail, Drive ou calendrier
n’est nécessaire. Les utilisateurs doivent posséder un compte Google Workspace
du domaine `studio-katra.com` ; une simple adresse de récupération de ce domaine
ne donne pas accès.

Dans les variables sécurisées de l’hébergement ou dans un fichier `.env` local
ignoré par Git, renseigner :

```dotenv
APP_URL=https://ADRESSE-PUBLIQUE-DE-CLOCK
GOOGLE_CLIENT_ID=identifiant-public-du-client
GOOGLE_CLIENT_SECRET=secret-a-renseigner-hors-du-code
NODE_ENV=production
DATABASE_PATH=./data/clock.sqlite
PORT=3000
```

Ne jamais envoyer le secret dans le chat, le navigateur ou Git. `.env.example`
contient les noms attendus. Le secret est utilisé exclusivement par le serveur.
`APP_URL` doit correspondre exactement à l’origine publique (schéma, domaine et
port). En production, HTTPS est obligatoire. Le proxy d’hébergement doit fournir
HTTPS et transférer les requêtes vers le port du serveur.

Les sessions durent huit heures et utilisent des cookies HttpOnly, SameSite=Lax
et Secure sous HTTPS. Chaque écriture vérifie aussi l’origine et un jeton CSRF.
Les jetons d’accès Google ne sont pas conservés.

Destinations HTTPS nécessaires : `accounts.google.com`, `oauth2.googleapis.com`
et `www.googleapis.com` (connexion, échange OAuth et certificats de vérification).

## Configurer Furious

Instance : `https://studio-katra.furious-squad.com/`.
Documentation : `https://studio-katra.furious-squad.com/api/documentation/`.
La version fournie en PDF a été lue ; les détails du contrat utilisé sont dans
[docs/furious-api.md](docs/furious-api.md).

Dans l’administration Furious, prévoir un **compte API dédié** avec les droits
de lecture Utilisateurs, Projets, Devis, Historique des heures quotidiennes et Temps,
ainsi que le droit de création des Temps. Ne pas utiliser le mot de passe Google
des collaborateurs. Renseigner, côté serveur uniquement :

```dotenv
FURIOUS_API_USERNAME=identifiant-du-compte-api
FURIOUS_API_PASSWORD=mot-de-passe-a-renseigner-hors-du-code
```

Dans l’environnement cloud, utiliser les champs de configuration et le secret
sécurisé prévus ; ne pas envoyer le mot de passe dans le chat. Un fichier `.env`
ignoré est également pris en charge en développement local.

Les requêtes utilisent `POST /api/v2/auth/`, puis l’en-tête `F-Auth-Token`.
Le jeton est conservé en mémoire et renouvelé avant expiration. Le client HTTP
respecte le proxy et la vérification TLS de l’environnement, impose un délai de
15 secondes, et ne suit pas les redirections ni ne relance les écritures.
Autoriser le domaine de l’instance dans les sorties réseau. Les champs présents
dans le brouillon cloud ne sont actifs qu’après application de la configuration.

Chaque utilisateur Google doit posséder **une unique fiche utilisateur active
dans Furious avec la même adresse e-mail**. Les temps sont attribués à son
`pseudo` Furious, jamais par défaut au compte API. La liste utilise `actif=1`
et applique `restricted_time_users` lorsqu’il est renseigné. Les autres limites
de visibilité dépendent des permissions du compte API : configurer son périmètre
en conséquence. Tous les projets ouverts de ce périmètre sont proposés aux
collaborateurs du studio en l’absence de restriction explicite.

La durée envoyée est `secondes / (heures_journalières × 3600)`. Par défaut,
l’horaire est lu dans `UserDailyHoursHistory`, en prenant la dernière valeur
effective à la date de la saisie. Une valeur manuelle dans les Réglages personnels
ou `FURIOUS_HOURS_PER_DAY` est prioritaire : l’historique n’est alors pas demandé,
même si le compte API ne peut pas le lire. Cette valeur doit correspondre
exactement à la journée utilisée dans Furious ; aucune journée de 7 ou 8 heures
n’est supposée en mode automatique. Pour l’installation Mac personnelle, le
propriétaire a confirmé une journée de 7 heures : cette référence est appliquée
aux réglages existants sans valeur et reste modifiable. Un horaire invalide ou
une correspondance ambiguë bloque l’envoi.

Les temps sont créés via `POST /api/v2/sprint/`, avec la même date de début et de
fin, une description et `is_validated=0` : **l’export ne valide pas automatiquement
les temps** dans Furious. La durée n’est pas arrondie localement. Le traitement
effectif des décimales par l’instance reste à confirmer lors de l’essai réel.

Si Furious demande une ligne de grille tarifaire, choisir la prestation dans le bloc du projet,
sous son nom, à côté du bouton ▶. Le choix est mémorisé par projet et accompagne
les prochains temps. Il complète aussi les saisies à exporter sans prestation ;
les affectations existantes sont conservées. La liste est lue dans `ProjectRateCard` pour
ce projet uniquement et exclut les lignes `exclude_from_sprint=1`. Le compte API
doit pouvoir consulter les **Grilles tarifaires projet**. Aucun tarif ni montant
n’est affiché ou modifié par Clock. Le choix explicite **Non vendu (hors grille)**
envoie `project_rate_card_id=-1`, comme documenté par Furious ; il n’est jamais
choisi automatiquement. Une prestation réelle est revalidée avant l’export.
Le choix est conservé sur la saisie et contrôlé lors d’une réconciliation.
Une migration ajoute deux colonnes SQLite sans supprimer les anciennes données.

### Exports interrompus

Le serveur réserve les saisies avant l’envoi pour éviter les doubles clics et
les exports concurrents. Il conserve l’identifiant Furious après confirmation
`success=true` avec un identifiant valide. Une référence stable `[Clock:UUID]`
est ajoutée à la description et recherchée avant toute création.

La documentation ne fournit pas de clé d’idempotence native : ce dispositif ne
garantit pas l’unicité si la base locale est perdue, si la référence est modifiée
dans Furious, ou si plusieurs instances Clock indépendantes exportent les mêmes
données. Conserver une seule instance et une base persistante sauvegardée.

Après un timeout ou une réponse ambiguë, la saisie reste **à vérifier** et n’est
jamais renvoyée automatiquement. La loupe « Vérifier dans Furious » recherche
la référence et contrôle la personne, le projet, les dates et la durée (tolérance
d’une seconde). Une correspondance unique confirme l’export **sans écriture
distante**. Un résultat absent, multiple ou différent laisse la saisie bloquée
pour vérification manuelle ; l’absence de résultat ne déclenche pas de renvoi.

Un refus explicite de création laisse en revanche la saisie à exporter et
modifiable. Les erreurs d’authentification ou de préparation n’immobilisent pas
les temps non envoyés. Les réponses d’erreur distantes ne sont jamais renvoyées
brutes au navigateur, car elles pourraient contenir des données sensibles.

## Règles de suivi

- Les données et la minuterie sont isolées par l’identifiant Google stable.
- Une seule minuterie par utilisateur, quel que soit le navigateur.
- Les projets peuvent être épinglés et désépinglés avec leur bouton dédié.
  Les épingles sont personnelles, persistantes et affichées en tête de liste,
  du plus récemment épinglé au plus ancien. La recherche conserve son filtre
  lors de l’épinglage. Un projet fermé ou inaccessible ne redevient pas visible
  du fait de son épingle.
- Démarrer un autre projet enregistre et arrête automatiquement le précédent,
  puis démarre le nouveau au même instant. Un clic sur le projet déjà en cours
  conserve sa minuterie. Si le nouveau démarrage échoue, l’ancien reste intact.
- Le chronomètre continue après fermeture de l’onglet ou redémarrage du serveur.
- Arrêter la minuterie enregistre les secondes écoulées ; une mesure inférieure
  à une seconde n’ajoute pas de saisie.
- Les journées utilisent `Europe/Paris`. Un temps traversant minuit est réparti
  entre les dates concernées, y compris aux changements d’heure.
- Seules les saisies non envoyées sont modifiables, de 1 seconde à 24 heures.
- L’export manuel concerne la journée courante ; il faut d’abord arrêter la
  minuterie. L’historique des journées passées reste consultable et modifiable
  pour les saisies non envoyées ; cette version propose l’export de la journée
  courante uniquement.
- Les sessions et les temps restent dans SQLite sur le serveur. L’hébergeur a
  techniquement accès à ces données ; elles ne sont pas chiffrées applicativement.

## Tests

```sh
cd /workspace/clock
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

Les tests serveur couvrent l’accès au domaine, OAuth avec state/PKCE/nonce,
les cookies, CSRF, l’isolation, la persistance, les changements d’heure et les
exports concurrents ou interrompus. Les tests Furious vérifient le contrat du
PDF, la pagination, les restrictions, la conversion des durées et les refus.
Les tests navigateur couvrent le parcours complet sur ordinateur et mobile,
ainsi qu’un export interrompu puis réconcilié sans renvoi. Ils utilisent des
bases temporaires en mémoire et une API Furious simulée, sans identifiants réels.

Pour les tests navigateur, installer Chromium dans l’environnement ou fournir
son chemin via `CHROMIUM_PATH`. Les tests démarrent un serveur isolé au port
3107 et un second au port 3108 pour l’intégration simulée. Le mode démonstration
interactif et ses données ne sont pas utilisés. Les routes `__test` du second
serveur n’existent pas dans `npm start` et n’utilisent aucun vrai secret.

## Exploitation

Utiliser une seule instance Node avec un volume persistant pour le répertoire
`data/`, et sauvegarder SQLite avec son API de sauvegarde ou à l’arrêt du serveur
(tenir compte des fichiers WAL si une sauvegarde est réalisée à chaud). Restreindre
l’accès aux sauvegardes et aux fichiers de données. La route `/health` vérifie que
le serveur répond ; elle n’atteste pas une connexion Google ou Furious fonctionnelle.

Avant ouverture à l’équipe : renseigner les accès API Furious, vérifier un vrai
compte du studio et le refus d’un compte externe, tester un export autorisé sur
un projet dédié et confirmer sa présence dans Furious, configurer le domaine
HTTPS et les sauvegardes. La création du code et la sauvegarde de la configuration
cloud ne constituent pas un déploiement.

## Dossiers et devis

La liste comporte les onglets **Dossiers** et **Devis**. Chaque onglet possède
sa recherche ; les dossiers et devis peuvent être épinglés indépendamment.
Démarrer un décompte sur une autre cible termine le précédent. Les temps de
devis sont identifiés dans le récapitulatif et exportés avec leur `proposal_id`.
Les devis gagnés et perdus sont exclus de la liste des devis ouverts.
Le compte API doit autoriser la consultation des Devis ; un refus ne bloque pas
les dossiers. Le contrat et les limites de validation figurent dans
[docs/furious-api.md](docs/furious-api.md).
