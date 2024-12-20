const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Validación de variables de entorno
const requiredEnvVars = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_APP_ID',
    'FIREBASE_SERVICE_ACCOUNT',
    'OPENAI_API_KEY'
];

requiredEnvVars.forEach((envVar) => {
    if (!process.env[envVar]) {
        console.error(`Error: La variable de entorno ${envVar} no está configurada.`);
        process.exit(1);
    }
});

// Configuración de Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
console.log("Firebase Admin inicializado correctamente.");

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
console.log("OpenAI inicializado correctamente.");

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'https://alexia.onrender.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Ruta para variables de entorno del cliente
app.get('/env-config.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.send(`window.ENV = {
        FIREBASE_API_KEY: "${process.env.FIREBASE_API_KEY}",
        FIREBASE_AUTH_DOMAIN: "${process.env.FIREBASE_AUTH_DOMAIN}",
        FIREBASE_PROJECT_ID: "${process.env.FIREBASE_PROJECT_ID}",
        FIREBASE_STORAGE_BUCKET: "${process.env.FIREBASE_STORAGE_BUCKET}",
        FIREBASE_MESSAGING_SENDER_ID: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
        FIREBASE_APP_ID: "${process.env.FIREBASE_APP_ID}"
    };`);
});

// Middleware de autenticación
const authenticateFirebase = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(403).json({ error: 'No token provided' });

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error de autenticación:', error);
        res.status(403).json({ error: 'Unauthorized', details: error.message });
    }
};

// Rutas
app.post('/chatWithAI', authenticateFirebase, async (req, res) => {
    try {
        const { message, model = 'gpt-4', temperature = 0.7, max_tokens = 500 } = req.body;

        if (!message) return res.status(400).json({ error: 'No message provided' });

        const completion = await openai.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: 'Eres un asistente legal especializado en leyes chilenas.' },
                { role: 'user', content: message }
            ],
            temperature,
            max_tokens
        });

        res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error en /chatWithAI:', error);
        res.status(500).json({ error: error.message });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public/menu.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public/chat.html')));

// Manejo de errores
app.use((req, res) => res.status(404).send('Página no encontrada'));

// Configuración del puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
