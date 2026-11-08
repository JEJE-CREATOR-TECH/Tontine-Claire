# Tontine Claire

La tontine où chaque membre voit qui a cotisé, l'ordre des tours et la date de fin.

- La gérante crée la tontine et envoie à chaque membre **un lien personnel** (pas de mot de passe).
- Chaque membre **déclare** son paiement ; la gérante le **confirme** à réception.
- Tout le groupe voit le **tableau des cotisations**, le tour en cours et la date de fin.
- Pour un membre qui a reçu sa part et ne paie plus : retard affiché, **arrangement** proposé (étalement ou report à la fin), message de relance.
- La gérante a un **lien de secours** pour retrouver son accès si elle change de téléphone.

## Ce qui est où

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css`, `app.js` | L'appli |
| `config.js` | L'adresse du projet Supabase et la clé publique |
| `supabase/schema.sql` | La base de données et ses règles de sécurité |
| `vendor/supabase.js` | La bibliothèque Supabase (version 2.118.0), incluse pour ne dépendre d'aucun autre site |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation sur le téléphone |

## Mise en place (une seule fois)

1. **Supabase** : créer un projet en Europe, puis **Authentication → Providers** : activer *Allow anonymous sign-ins*.
2. **SQL Editor → New query** : coller tout le contenu de `supabase/schema.sql`, puis **Run**.
3. Remplir `config.js` avec **Project URL** et la clé **anon / publishable** (jamais la clé *service_role* ou *secret*).
4. **GitHub Pages** : Settings → Pages → Branch `main`, dossier `/ (root)`.

## Sécurité et données

- Chaque membre ne peut lire **que** les tontines dont elle fait partie (règles « Row Level Security »).
- Toutes les modifications passent par des fonctions qui vérifient les droits : un membre ne peut pas confirmer un paiement ni modifier celui d'une autre.
- Les liens d'invitation ne sont visibles que par la gérante. Un lien utilisé ne fonctionne plus sur un autre téléphone.
- L'appli **ne manipule pas d'argent** : elle enregistre seulement qui a payé. Les paiements se font comme d'habitude (Wave, Orange Money, virement, espèces).
- Les données sont hébergées par Supabase, dans la région choisie (Europe).

## Publier une mise à jour

Remplacer les fichiers, puis augmenter le numéro de `CACHE` dans `sw.js` (`tontine-claire-1` → `tontine-claire-2`).

## Avant une diffusion large

- Rédiger une politique de confidentialité et des mentions légales (nom de l'éditrice, hébergeur, durée de conservation, droit de suppression).
- Prévoir l'effacement des données à la fin d'une tontine (la gérante peut déjà supprimer une tontine).
- Si un jour l'appli encaisse elle-même les cotisations, un agrément d'établissement de paiement est nécessaire : ce n'est pas le cas de cette version.
