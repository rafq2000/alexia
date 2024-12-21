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
app.use(cors());
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
app.post('/chatWithAI', authenticateUser, async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Mensaje faltante' });
        }

        console.log('Procesando mensaje:', message);

        // Incrementar contador de consultas
        await db.collection('stats').doc('global').set({
            totalConsultas: admin.firestore.FieldValue.increment(1),
            ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `Eres un asistente legal especializado en leyes chilenas, específicamente en:
                    - Deudas bancarias y créditos
                    - Repactaciones y refinanciamientos
                    - Quiebra personal e insolvencia
                    - Ley 20.720 de Reorganización y Liquidación
                    - Negociación con bancos y acreedores
                    
                    Proporciona respuestas claras, prácticas y enfocadas en estos temas financieros y legales.
                    Si te preguntan sobre otros temas, indica amablemente que tu especialidad es en temas de deudas
                    e insolvencia. Usa un lenguaje simple y explica los términos técnicos cuando sea necesario.`
                },
                { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 800
        });

        console.log('Respuesta generada correctamente');
        return res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error detallado en chatWithAI:', error);
        return res.status(500).json({ error: 'Error al procesar la consulta' });
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

// Manejo de errores
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});