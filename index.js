const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Middleware para verificar rutas válidas
const validRoutes = ['/', '/menu', '/chat'];

app.use((req, res, next) => {
    // Si es un archivo estático, continuar
    if (req.path.includes('.')) {
        return next();
    }
    
    // Si es una ruta válida, continuar
    if (validRoutes.includes(req.path)) {
        return next();
    }
    
    // Si no es una ruta válida y no es un archivo, enviar 404
    res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Configuraciones CORS
app.use(cors({
    origin: ['https://alexia.onrender.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Rutas de la API
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

// Inicialización de Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
}

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Rutas específicas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/menu.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// Ya no necesitamos el middleware 404 aquí porque lo manejamos arriba

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});