# Contrat Furious utilisé par Clock

Source : `html_print.pdf`, 211 pages, transmis par l’administrateur du studio.
La numérotation ci-dessous correspond aux numéros imprimés dans le document.
URL de référence : https://studio-katra.furious-squad.com/api/documentation/.
Ce document résume les champs nécessaires, sans reproduire de secret ni de jeton.

## Authentification — page 1

`POST /api/v2/auth/` :

```json
{"action":"auth","data":{"username":"COMPTE_API","password":"SECRET"}}
```

Succès : `{"success":true,"token":"…","expires_in":3600}`.
Les autres opérations transmettent le jeton dans `F-Auth-Token`.
Les identifiants sont ceux d’un utilisateur API, pas la connexion Google SSO.

## Recherches — pages 2 à 5

Les GET utilisent un paramètre URL `query`, avec la syntaxe documentée :

```text
{Model(limit:250,offset:0,order:[{id:asc}],filter:{field:{eq:"value"}}){id,field}}
```

Les chaînes de filtre sont encodées avec JSON, puis le paramètre entier est
encodé dans l’URL. `limit` est compris entre 1 et 250. Les opérateurs employés
par Clock sont `eq`, `leq` et `like`. La réponse documentée est :

```json
{"success":true,"data":{"Model":[]},"meta":{"totalElementsWithFilters":0}}
```

Ne pas confondre `totalElements` (sans filtres) avec le total filtré.
Clock parcourt la pagination, détecte les identifiants répétés et refuse
d’afficher une liste dont il détecte l’incomplétude.

## Collaborateur — pages 172 à 173

`GET /api/v2/user/`, modèle `User`, filtre `email.eq` et champs `id,pseudo,email`.
Une unique correspondance exacte, sans distinction de casse pour l’email, est
requise. Aucun rapprochement par prénom ni repli vers le compte API.

## Projets — pages 82 à 84

`GET /api/v2/project/`, modèle `Project`, filtre `actif.eq:"1"`.
Champs utilisés : `id,title,company_name,actif,restricted_time_users`.

La table de référence du modèle documente `title`, même si un exemple générique
plus haut emploie `name`. Clock utilise le champ de la table du modèle.
`restricted_time_users` contient des pseudos séparés par des virgules ; le
document présente également les tableaux dans le contrat de création.
Un projet restreint est montré uniquement si le pseudo du collaborateur y figure.
Les droits du compte API limitent aussi les résultats accessibles.

## Horaire journalier — page 158

`GET /api/v2/user-daily-hours-history/`, modèle `UserDailyHoursHistory`.
Champs `id,user_id,date,daily_hours` ; filtre sur `user_id` et `date.leq` de la
saisie ; ordre `date:desc,id:desc`, limite 1. La dernière valeur à la date de la
saisie sert à convertir la durée en jours. Aucune valeur par défaut n’est déduite
des exemples numériques du document. Un secours global explicite est possible
si aucun enregistrement n’est présent, via `FURIOUS_HOURS_PER_DAY`.

## Création du temps — pages 99 à 100

`POST /api/v2/sprint/`, action `create`.
Champs obligatoires : `sprint_name`, `project_id` (entier), `start_date` et
`end_date` (`Y-m-d`), `num_days` (nombre décimal), `assigned_people` (pseudo).
Clock utilise aussi les champs facultatifs `description`, `is_validated:0`
et `priority:2` (normal).

```text
num_days = durée_en_secondes / (daily_hours × 3600)
```

Les heures de début et de fin sont omises : les durées peuvent être corrigées
avant export et ne correspondent pas nécessairement à un créneau continu.
Une confirmation requiert `success:true` et un `id` valide, jamais le seul
statut HTTP. Le multibatch existe (10 éléments maximum, pages 1 à 2), mais Clock
envoie une saisie à la fois pour conserver un résultat individuel fiable.

## Relecture — pages 100 à 102

`GET /api/v2/sprint/`, modèle `Sprint`. Le champ `description` est filtrable avec
`like`. Clock ajoute à chaque description une référence `[Clock:UUID]`, puis
cherche celle-ci avant création et lors d’une réconciliation.

Champs de contrôle : `id,project_id,assigned_people,start_date,end_date,
time_in_hours,description`. La durée de lecture est en **heures**, celle
d’écriture en **jours**. Une référence multiple ou des champs différents
empêchent toute confirmation automatique.

Le document ne décrit pas de garantie transactionnelle d’idempotence ni de délai
de cohérence des recherches : une recherche sans résultat après un timeout
n’autorise donc pas un renvoi automatique.

## À confirmer sur l’instance

- Droits du compte API sur les cinq ressources utilisées.
- Correspondance des emails Google et des pseudos Furious.
- Présence des historiques d’horaires, ou valeur explicite du secours.
- Précision des décimales conservées dans `num_days` et `time_in_hours`.
- Projet dédié permettant un export de validation autorisé.

Les tests automatisés vérifient ce contrat à l’aide de réponses simulées. Ils
ne prouvent pas la disponibilité, les permissions ou le résultat d’un export
sur l’instance réelle.
