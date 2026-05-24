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
        // Le patient n'est PAS modérateur (c'est le médecin
        // qui modère). On met "moderator: false".
        moderator: false
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

/* ----------------------------------------------------------
   Route de test : vérifier que le serveur tourne
   ---------------------------------------------------------- */

app.get('/', (req, res) => {
  res.send('Serveur de tickets Antso — en ligne.');
});

app.listen(PORT, () => {
  console.log('Serveur de tickets Antso démarré sur le port ' + PORT);
});
