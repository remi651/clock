# Mise en ligne de Clock sur Render

La configuration est prête pour `clock.studio-katra.com`. Elle n’a pas encore
été exécutée sur Render. Les tarifs, l’accès au dépôt et la configuration doivent
être confirmés dans votre compte avant création du service.

## Ce qui est préparé

`render.yaml` décrit un service Node.js 24, une instance unique dans la région
Frankfurt et un disque persistant de 1 Go. Le disque est monté dans `/var/data` ;
SQLite y conserve temps, épingles et sessions. Les mises à jour automatiques
depuis GitHub sont désactivées. Les futurs déploiements seront manuels.

La commande d’installation est `npm ci --omit=dev --no-fund`, le démarrage
`npm start`. Render fournit le port via `PORT` ; le serveur écoute sur `0.0.0.0`.
`NODE_ENV=production` interdit le mode démonstration et exige les quatre champs
d’accès. Le serveur attend les requêtes en cours lors d’un arrêt, dans une limite
de 20 secondes. Une interruption d’export est réconciliée à la reprise.

Le dépôt contient les tests et leur configuration GitHub Actions. Une exécution
locale réussie ne garantit pas qu’un workflow distant ait été exécuté : vérifier
son résultat dans GitHub avant déploiement. Aucun test automatique ne doit créer
de temps dans votre instance Furious.

## À faire dans votre compte Render

1. Ouvrir https://dashboard.render.com/ et créer votre compte ou vous connecter.
2. Autoriser Render à lire le dépôt GitHub `remi651/clock`. Si GitHub propose de
   choisir les dépôts autorisés, sélectionner uniquement `clock`.
3. Créer un **Blueprint** à partir de ce dépôt, branche `main`. Render lit le
   fichier `render.yaml` et présente les ressources à créer.
4. Vérifier le coût du service **Starter** et du disque persistant avant de
   confirmer. Le palier gratuit sans disque ne convient pas à cette base SQLite.
   Le montant exact est celui affiché par Render, pas une estimation du dépôt.
5. Renseigner les quatre champs demandés dans les zones sécurisées :

   | Champ | Où retrouver la valeur |
   |---|---|
   | `GOOGLE_CLIENT_ID` | Client OAuth « Katra Clock » dans Google Cloud |
   | `GOOGLE_CLIENT_SECRET` | Code secret du même client OAuth |
   | `FURIOUS_API_USERNAME` | Identifiant du compte API Furious dédié |
   | `FURIOUS_API_PASSWORD` | Mot de passe du compte API Furious dédié |

   Utiliser les valeurs originales, pas les éventuels masques ou placeholders
   visibles dans l’environnement cloud. Elles ne sont ni présentes dans GitHub,
   ni copiées automatiquement depuis cette conversation. Ne pas les partager
   dans le chat, dans une capture ou dans un fichier versionné.
6. Confirmer la création lorsque vous êtes prêt à lancer le service payant.
   La publication antérieure de l’environnement cloud est une opération distincte.

Si le bouton ou les libellés de votre interface Render diffèrent, transmettre
une capture en masquant les secrets avant de confirmer une action payante.

## Relier le sous-domaine

Dans le service Render, ouvrir les réglages de domaine personnalisé. Le Blueprint
demande `clock.studio-katra.com` ; vérifier sa présence, puis relever **la cible
DNS exacte affichée par Render**.

Dans le gestionnaire DNS de `studio-katra.com`, créer l’enregistrement CNAME
demandé pour le sous-domaine `clock`, vers cette cible. Ne pas modifier les
enregistrements de messagerie ni le domaine principal. S’il existe déjà un
enregistrement pour `clock`, vérifier son usage avant de le remplacer.

Lancer ensuite la vérification du domaine dans Render et attendre que le
certificat HTTPS soit actif. Ne pas deviner la cible DNS à partir du nom du
service. Le simple fait de connaître l’adresse du site n’accorde pas l’accès :
les projets et les temps exigent toujours la connexion Google du studio.

## Finaliser Google

Dans Google Cloud, ouvrir le client OAuth « Katra Clock », de type application
web, et ajouter cette URI de redirection autorisée exacte :

```text
https://clock.studio-katra.com/auth/google/callback
```

Conserver l’URI locale si vous souhaitez continuer les essais sur votre Mac.
L’audience doit rester interne à votre organisation Google Workspace, et les
autorisations limitées à `openid`, `email`, `profile`. Le serveur applique aussi
le contrôle du domaine `studio-katra.com` sur le jeton signé.

`APP_URL` est déjà fixé à `https://clock.studio-katra.com` dans le Blueprint.
Avant que le DNS et le certificat soient prêts, l’adresse provisoire Render
peut répondre sur `/health`, mais la connexion Google reste configurée pour le
domaine définitif : son retour ne fonctionnera pas encore.

## Vérification avant invitation de l’équipe

1. Vérifier que le déploiement réussit et que `/health` répond `status: ok`.
2. Se connecter avec un compte Google Workspace `studio-katra.com`, puis vérifier
   que la même adresse correspond à une unique fiche utilisateur Furious.
3. Vérifier qu’un compte extérieur au domaine est refusé.
4. Épingler un projet, lancer puis changer de minuterie, et vérifier l’historique
   après rechargement. Aucun temps n’est envoyé sans clic d’export.
5. Tester un export **autorisé** sur un projet prévu pour cela et contrôler la
   personne, la date et la durée dans Furious. L’export crée de vrais temps.
6. Configurer la sauvegarde et vérifier sa restauration avant ouverture à l’équipe.

La route `/health` ne prouve ni l’authentification Google ni une écriture Furious.
Le traitement exact des fractions de jour par l’instance doit être confirmé par
ce premier essai réel. Le compte API doit pouvoir lire les utilisateurs, projets,
historiques d’horaires et temps, et créer des temps.

## Conservation et mises à jour

Conserver le disque existant lors des mises à jour. Ne pas multiplier les
instances ni utiliser une seconde base SQLite en parallèle. Un changement de
code n’applique pas de nouvelle version tant qu’un déploiement manuel n’est pas
demandé dans Render. Un retour à une version précédente du code ne restaure pas
automatiquement la base de données.

Prévoir une sauvegarde SQLite cohérente : utiliser son API de sauvegarde à chaud,
ou arrêter le service et conserver tous les fichiers requis. Copier uniquement
`clock.sqlite` pendant une écriture peut ignorer les transactions du journal WAL.
Vérifier dans Render les options de snapshot et de restauration du disque et
prévoir une copie externe protégée selon vos exigences de conservation.

Références : https://render.com/docs/infrastructure-as-code et
https://render.com/docs/blueprint-spec. La validation et la création effectives
dans votre compte Render restent à effectuer.
