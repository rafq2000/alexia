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

// Inicialización de Firebase Admin y Firestore
const db = admin.firestore();
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

// Middleware de autenticación de admin
const adminEmails = ['TU_EMAIL@gmail.com']; // Cambia esto por tu email

const authenticateAdmin = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        if (!adminEmails.includes(decodedToken.email)) {
            return res.status(403).json({ error: 'No autorizado' });
        }
        req.user = decodedToken;
        next();
    } catch (error) {
        res.status(403).json({ error: 'Token inválido' });
    }
};

// Middleware de autenticación general
const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        res.status(403).json({ error: 'Token inválido' });
    }
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

// Ruta para estadísticas de admin
app.get('/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const statsRef = await db.collection('stats').doc('global').get();
        const whatsappRef = await db.collection('stats').doc('whatsapp').get();
        const usersRef = await db.collection('users').get();

        res.json({
            totalConsultas: statsRef.data()?.totalConsultas || 0,
            consultasWhatsapp: whatsappRef.data()?.total || 0,
            usuariosRegistrados: usersRef.size,
            ultimaActualizacion: new Date()
        });
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// Ruta del chat
app.post('/chatWithAI', authenticateUser, async (req, res) => {
    try {
        // Incrementar contador de consultas
        await db.collection('stats').doc('global').set({
            totalConsultas: admin.firestore.FieldValue.increment(1),
            ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Registrar detalle de consulta
        await db.collection('consultas').add({
            userId: req.user.uid,
            categoria: req.body.category,
            mensaje: req.body.message,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'Eres un asistente legal especializado en leyes chilenas.'
                },
                { role: 'user', content: req.body.message }
            ],
            max_tokens: 500
        });

        res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error en chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rutas principales
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/menu.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/chat.html'));
});

app.get('/admin', authenticateAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
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