const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Inicialización de Firebase Admin PRIMERO
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado correctamente");
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
}

// Inicialización de Firestore
const db = admin.firestore();

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Configuraciones CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Ruta para variables de entorno del cliente
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

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Middleware de autenticación
const authenticateUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error de autenticación:', error);
        res.status(403).json({ error: 'Token inválido' });
    }
};

// Ruta del chat
app.post('/api/chatWithAI', authenticateUser, async (req, res) => {
    try {
        const { message, category } = req.body;
        
        if (!message || !category) {
            return res.status(400).json({ error: 'Mensaje o categoría faltante' });
        }

        // Agregar logging para debug
        console.log('Procesando mensaje:', { message, category });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `Eres un asistente legal especializado en leyes chilenas, específicamente en:
                    - Deudas bancarias
                    - Créditos y repactaciones
                    - Quiebra personal
                    - Insolvencia
                    - Ley 20.720 de Reorganización y Liquidación
                    
                    Da respuestas claras y prácticas enfocadas en estos temas.`
                },
                { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        // Log de respuesta exitosa
        console.log('Respuesta generada exitosamente');

        return res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error detallado en chatWithAI:', error);
        
        // Respuesta de error más específica
        return res.status(500).json({ 
            error: 'Error al procesar la consulta',
            details: error.message
        });
    }
});

// Estadísticas
app.get('/stats', authenticateUser, async (req, res) => {
    try {
        const statsRef = await db.collection('stats').doc('global').get();
        const stats = statsRef.data() || { totalConsultas: 0 };
        res.json(stats);
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
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

// Error 404
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public/index.html'));
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