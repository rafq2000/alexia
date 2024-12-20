const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Servir archivos estáticos primero
app.use(express.static(path.join(__dirname, 'public')));

// Configuraciones CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Middleware para verificar disponibilidad de variables de entorno
const checkEnvVariables = () => {
    const requiredVars = [
        'FIREBASE_API_KEY',
        'FIREBASE_AUTH_DOMAIN',
        'FIREBASE_PROJECT_ID',
        'FIREBASE_STORAGE_BUCKET',
        'FIREBASE_MESSAGING_SENDER_ID',
        'FIREBASE_APP_ID',
        'FIREBASE_SERVICE_ACCOUNT',
        'OPENAI_API_KEY'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        console.warn('Warning: Missing environment variables:', missingVars.join(', '));
        return false;
    }
    return true;
};

// Ruta para las variables de entorno del cliente
app.get('/env-config.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    const envVars = {
        FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || '',
        FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || '',
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
        FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
        FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
        FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || ''
    };
    res.send(`window.ENV = ${JSON.stringify(envVars)};`);
});

// Inicialización de Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (serviceAccount.project_id) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin inicializado correctamente");
    }
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
}

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ''
});

// API Routes
app.post('/api/chatWithAI', async (req, res) => {
    try {
        // Aquí va tu lógica de chat
        res.json({ success: true });
    } catch (error) {
        console.error('Error en chat:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Rutas principales
const sendIndexHtml = (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
};

app.get('/', sendIndexHtml);
app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/menu.html'));
});
app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// Manejo de errores
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('¡Algo salió mal!');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    checkEnvVariables();
});

// Manejo de errores del servidor
server.on('error', (error) => {
    if (error.syscall !== 'listen') {
        throw error;
    }
    switch (error.code) {
        case 'EACCES':
            console.error(`El puerto ${PORT} requiere privilegios elevados`);
            process.exit(1);
            break;
        case 'EADDRINUSE':
            console.error(`El puerto ${PORT} ya está en uso`);
            process.exit(1);
            break;
        default:
            throw error;
    }
});