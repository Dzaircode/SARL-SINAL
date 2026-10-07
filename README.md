# Inventaire informatique — SARL SINAL

Application autonome en HTML, CSS et JavaScript. Aucun serveur de développement ni compilation n'est nécessaire.

## Firebase

1. Créez un projet dans la [console Firebase](https://console.firebase.google.com/) et ajoutez une application Web.
2. Activez **Authentication → Sign-in method → E-mail/Mot de passe**. Créez un compte utilisateur depuis l'onglet **Utilisateurs**.
3. Créez une base **Realtime Database** dans la région souhaitée.
4. Vérifiez que `databaseURL` dans `firebase-config.js` contient l'URL exacte de **Realtime Database → Données**. Remplacez aussi les autres valeurs de configuration par celles de l'application Web si nécessaire.
5. Publiez les règles suivantes dans **Realtime Database → Règles** :

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

6. Ouvrez `index.html` dans un navigateur connecté à Internet. Après connexion, l'application redirige vers `app.html`. Les modules Firebase et SheetJS sont chargés depuis des CDN. Utilisez un serveur statique local si le navigateur bloque les modules pour les fichiers `file://` (par exemple l'extension Live Server).

Les données sont stockées dans les nœuds `unites_centrales`, `laptops`, `imprimantes` et `historique`. Les abonnements `onValue` synchronisent les changements en temps réel. Le SDK Web de Realtime Database garde les écritures en attente pendant une coupure tant que l'onglet reste ouvert, mais ne fournit pas de cache persistant hors ligne après fermeture du navigateur. Les données déjà présentes dans Cloud Firestore ne sont pas copiées automatiquement ; importez à nouveau le classeur Excel dans l'application ou migrez ces données séparément.

## Feuilles et import/export

Les collections sont `unites_centrales`, `laptops`, `imprimantes` et `historique`. L'import attend les en-têtes à la ligne 4 des trois feuilles d'équipement, et à la ligne 5 de la feuille Historique. L'import ignore les lignes vides et les clés N° Série + N° PC déjà présentes dans les feuilles d'équipement ; dans Historique, il ignore uniquement un événement entièrement identique afin de conserver les réaffectations successives. L'export génère un classeur `.xlsx` avec les quatre onglets, leurs titres et les en-têtes bleu foncé.

Les largeurs visibles sont définies dans `app.js`, car le classeur source n'est pas distribué avec ces fichiers.

La configuration Firebase est initialisée une seule fois dans `firebase.js` et partagée par `login.js` et `app.js`. Les noms de colonnes sont encodés pour les stocker en toute sécurité dans les clés Realtime Database, notamment celles contenant « / ».
