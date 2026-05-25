/* =====================================================
   ANTSO URGENCE — Serveur générateur de tickets (JWT)
   -----------------------------------------------------
   Ce petit serveur a UN seul rôle : fabriquer un "ticket"
   (JWT) signé qui prouve à JaaS que l'app a le droit de
   créer une salle de consultation.

   POURQUOI un serveur ?
   La clé privée JaaS ne doit JAMAIS être mise dans l'APK
   (quelqu'un pourrait l'extraire). Elle reste donc ici,
   sur le serveur, en sécurité.

   COMMENT le lancer :
     1. Installer Node.js (https://nodejs.org)
     2. Dans ce dossier : npm install
     3. Configurer les 3 variables ci-dessous
     4. Lancer : node server.js
   ===================================================== */

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/* ----------------------------------------------------------
   CONFIGURATION — À REMPLIR avec tes infos JaaS
   ----------------------------------------------------------
   Pour la sécurité, on lit ces valeurs depuis les
   "variables d'environnement". Sur Render, tu les
   saisiras dans l'onglet "Environment" (voir le guide).
   ---------------------------------------------------------- */

// 1) Ton AppID JaaS (commence par "vpaas-magic-cookie-...")
const APP_ID = process.env.JAAS_APP_ID || '';

// 2) Le Key ID de ta clé API
const API_KEY_ID = process.env.JAAS_KEY_ID || '';

// 3) Le contenu de ta clé privée (-----BEGIN PRIVATE KEY-----...)
const PRIVATE_KEY = process.env.JAAS_PRIVATE_KEY || '';

/* ----------------------------------------------------------
   Le serveur web
   ---------------------------------------------------------- */

const app = express();
app.use(cors());           // autorise l'app à appeler ce serveur
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ----------------------------------------------------------
   Route principale : fabriquer un ticket
   ----------------------------------------------------------
   L'app appelle :  GET /token?room=NOM&name=PRENOM
   Le serveur renvoie : { "token": "xxxxx.yyyyy.zzzzz" }
   ---------------------------------------------------------- */

app.get('/token', (req, res) => {
  // Vérifier que le serveur est bien configuré
  if (!APP_ID || !API_KEY_ID || !PRIVATE_KEY) {
    return res.status(500).json({
      error: 'Serveur non configuré (AppID / KeyID / clé privée manquants)'
    });
  }

  // Récupérer le nom de la salle et le nom du patient
  const room = (req.query.room || '*').toString();
  const userName = (req.query.name || 'Patient').toString();

  // Date d'expiration : le ticket est valable 2 heures
  const now = Math.floor(Date.now() / 1000);
  const expire = now + 2 * 60 * 60;

  // Le contenu du ticket (ce que JaaS va vérifier)
  const payload = {
    aud: 'jitsi',
    iss: 'chat',
    sub: APP_ID,
    room: room,
    exp: expire,
    nbf: now - 10,
    context: {
      user: {
        name: userName,
        // Consultation à deux (patient + médecin) : les DEUX
        // doivent avoir le contrôle total de leur micro/caméra.
        // On met donc "moderator: true" pour chaque participant.
        moderator: true
      },
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
        'outbound-call': false
      }
    }
  };

  try {
    // Signer le ticket avec la clé privée (algorithme RS256)
    const token = jwt.sign(payload, PRIVATE_KEY, {
      algorithm: 'RS256',
      header: {
        kid: API_KEY_ID,
        typ: 'JWT'
      }
    });
    res.json({ token: token });
  } catch (err) {
    console.error('Erreur de signature :', err.message);
    res.status(500).json({ error: 'Impossible de générer le ticket' });
  }
});

/* ===========================================================
   ===========================================================
   NOUVEAU — FILE D'ATTENTE PARTAGÉE DES DEMANDES
   ===========================================================
   ===========================================================

   POURQUOI ce code ?
   Avant, le patient et le médecin partageaient leurs demandes
   via "localStorage". Mais localStorage est privé à chaque
   appareil : le téléphone du patient et le PC du médecin ne
   peuvent pas le partager.

   Ce serveur devient donc le "tableau blanc central" :
     - le PATIENT y dépose sa demande
     - le MÉDECIN la lit, et y répond (accepte / refuse)

   On stocke la liste des demandes en mémoire (variable
   "requests"). C'est simple et suffisant : une demande de
   consultation ne dure que quelques minutes.

   ATTENTION : sur Render gratuit, le serveur "s'endort" après
   15 min d'inactivité et la mémoire est effacée. Ce n'est pas
   grave ici : les vieilles demandes seraient de toute façon
   nettoyées. On en reparlera si tu veux une base de données.
   =========================================================== */

// La liste de toutes les demandes. Chaque demande est un objet
// qui ressemble à ce que l'app Patient envoyait dans localStorage.
let requests = [];

/* -----------------------------------------------------------
   Petit nettoyage automatique
   -----------------------------------------------------------
   Toutes les 5 minutes, on supprime les demandes trop vieilles
   (plus de 30 minutes) pour que la liste ne grossisse pas
   indéfiniment. Une demande non traitée en 30 min est périmée.
   ----------------------------------------------------------- */
const REQUEST_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
  const now = Date.now();
  const avant = requests.length;
  requests = requests.filter(r => (now - r.timestamp) < REQUEST_MAX_AGE_MS);
  if (requests.length !== avant) {
    console.log('Nettoyage : ' + (avant - requests.length) + ' demande(s) périmée(s) supprimée(s).');
  }
}, 5 * 60 * 1000); // toutes les 5 minutes

/* -----------------------------------------------------------
   ROUTE 1 — Le PATIENT envoie une nouvelle demande
   -----------------------------------------------------------
   L'app Patient appelle :  POST /requests
   avec dans le corps (JSON) :
     {
       "patientName": "...",
       "doctorId": "d1",
       "doctorName": "Antso 1",
       "doctorRoom": "antso-urgence-...",
       "location": { "lat": ..., "lng": ... }  (ou null)
     }
   Le serveur crée la demande, lui donne un identifiant unique,
   et renvoie la demande complète (avec son "id").
   ----------------------------------------------------------- */
app.post('/requests', (req, res) => {
  const body = req.body || {};

  // Vérification minimale : il faut au moins un nom et un médecin.
  if (!body.patientName || !body.doctorId) {
    return res.status(400).json({ error: 'patientName et doctorId sont obligatoires' });
  }

  // On fabrique un identifiant unique pour cette demande.
  const id = Date.now() + '-' + Math.random().toString(36).substr(2, 6);

  // On construit l'objet demande (mêmes champs qu'avant).
  const nouvelleDemande = {
    id: id,
    patientName: String(body.patientName),
    doctorId: String(body.doctorId),
    doctorName: body.doctorName ? String(body.doctorName) : '',
    doctorRoom: body.doctorRoom ? String(body.doctorRoom) : '',
    location: body.location || null,
    status: 'waiting',   // waiting -> accepted / rejected
    token: null,         // sera rempli quand le médecin accepte
    timestamp: Date.now(),
    acceptedAt: null
  };

  requests.push(nouvelleDemande);
  console.log('Nouvelle demande de ' + nouvelleDemande.patientName +
              ' pour ' + nouvelleDemande.doctorId);

  // On renvoie la demande créée : l'app Patient a besoin du "id".
  res.json(nouvelleDemande);
});

/* -----------------------------------------------------------
   ROUTE 2 — Le MÉDECIN lit les demandes
   -----------------------------------------------------------
   L'app Médecin appelle :  GET /requests?doctorId=d1
   Le serveur renvoie la liste des demandes EN ATTENTE pour
   ce médecin :  { "requests": [ ... ] }

   Si on ne précise pas doctorId, on renvoie toutes les
   demandes en attente (pratique pour déboguer).
   ----------------------------------------------------------- */
app.get('/requests', (req, res) => {
  const doctorId = req.query.doctorId ? String(req.query.doctorId) : null;

  let resultat = requests.filter(r => r.status === 'waiting');
  if (doctorId) {
    resultat = resultat.filter(r => r.doctorId === doctorId);
  }

  // On trie de la plus ancienne à la plus récente (file d'attente).
  resultat.sort((a, b) => a.timestamp - b.timestamp);

  res.json({ requests: resultat });
});

/* -----------------------------------------------------------
   ROUTE 3 — Le PATIENT vérifie l'état de SA demande
   -----------------------------------------------------------
   L'app Patient appelle :  GET /requests/UN_ID
   Le serveur renvoie la demande complète, pour que le patient
   sache s'il est encore en attente, accepté, ou refusé.

   Si la demande n'existe plus (périmée ou annulée), on renvoie
   une erreur 404 : l'app Patient saura que c'est terminé.
   ----------------------------------------------------------- */
app.get('/requests/:id', (req, res) => {
  const id = String(req.params.id);
  const demande = requests.find(r => r.id === id);

  if (!demande) {
    return res.status(404).json({ error: 'Demande introuvable' });
  }

  res.json(demande);
});

/* -----------------------------------------------------------
   ROUTE 4 — Le MÉDECIN accepte (ou refuse) une demande
   -----------------------------------------------------------
   L'app Médecin appelle :  POST /requests/UN_ID/accept
   avec dans le corps (JSON), au choix :
     - pour ACCEPTER : { "action": "accept", "token": "le-jeton-du-patient" }
     - pour REFUSER  : { "action": "reject" }

   Le serveur change le statut de la demande et, en cas
   d'acceptation, y enregistre le jeton du patient. L'app
   Patient découvrira ce changement via la ROUTE 3.
   ----------------------------------------------------------- */
app.post('/requests/:id/accept', (req, res) => {
  const id = String(req.params.id);
  const body = req.body || {};
  const demande = requests.find(r => r.id === id);

  if (!demande) {
    return res.status(404).json({ error: 'Demande introuvable' });
  }

  const action = body.action || 'accept';

  if (action === 'reject') {
    demande.status = 'rejected';
    console.log('Demande ' + id + ' refusée.');
    return res.json(demande);
  }

  // Cas "accept" : on a besoin du jeton du patient.
  if (!body.token) {
    return res.status(400).json({ error: 'token obligatoire pour accepter' });
  }

  demande.status = 'accepted';
  demande.token = String(body.token);
  demande.acceptedAt = Date.now();
  console.log('Demande ' + id + ' acceptée.');

  res.json(demande);
});

/* ===========================================================
   FIN DU NOUVEAU CODE — FILE D'ATTENTE
   =========================================================== */

/* ----------------------------------------------------------
   Route de test : vérifier que le serveur tourne
   ---------------------------------------------------------- */

app.get('/', (req, res) => {
  res.send('Serveur de tickets Antso — en ligne.');
});

app.listen(PORT, () => {
  console.log('Serveur de tickets Antso démarré sur le port ' + PORT);
});
