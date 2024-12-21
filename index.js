const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Inicialización de Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado correctamente");
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
    process.exit(1); // Terminar si Firebase no se inicializa correctamente
}

// Inicialización de Firestore
const db = admin.firestore();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de env para el cliente
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

// Middleware de autenticación mejorado
const authenticateUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ 
                error: 'Token no proporcionado',
                details: 'Se requiere un token de autenticación válido'
            });
        }

        const token = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken;
            next();
        } catch (tokenError) {
            console.error('Error al verificar token:', tokenError);
            return res.status(403).json({ 
                error: 'Token inválido',
                details: 'El token proporcionado no es válido o ha expirado'
            });
        }
    } catch (error) {
        console.error('Error en autenticación:', error);
        return res.status(500).json({ 
            error: 'Error de autenticación',
            details: 'Error interno en el proceso de autenticación'
        });
    }
};

// Ruta de verificación de salud del servidor
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// Ruta del chat mejorada
app.post('/api/chatWithAI', authenticateUser, async (req, res) => {
    const startTime = Date.now();
    try {
        const { message, category, conversationHistory = [] } = req.body;
        
        if (!message) {
            return res.status(400).json({ 
                error: 'Mensaje faltante',
                details: 'Se requiere un mensaje para procesar'
            });
        }

        console.log(`Procesando mensaje para usuario ${req.user.uid} en categoría ${category}`);

        // Construir el contexto del sistema basado en la categoría
        let systemContent = `Eres un asistente legal especializado en leyes chilenas, específicamente en:
        - Deudas bancarias y créditos
        - Repactaciones y refinanciamientos
        - Quiebra personal e insolvencia
        - Ley 20.720 de Reorganización y Liquidación
        - Negociación con bancos y acreedores

        Instrucciones específicas:
        1. Proporciona respuestas claras y prácticas
        2. Usa lenguaje simple y explica términos técnicos
        3. Si te preguntan sobre otros temas, indica amablemente que tu especialidad es en temas de deudas
        4. Proporciona información basada en la legislación chilena actual
        5. Da ejemplos prácticos cuando sea apropiado

        Cuando des consejos legales, siempre aclara que es información general y que cada caso específico 
        puede requerir la evaluación de un abogado.`;

        // Preparar los mensajes para OpenAI
        let messages = [
            { role: 'system', content: systemContent }
        ];

        // Agregar historial de conversación si existe
        if (conversationHistory.length > 0) {
            messages = [...messages, ...conversationHistory.slice(-5)]; // Mantener últimos 5 mensajes
        }

        // Agregar mensaje actual
        messages.push({ role: 'user', content: message });

        // Generar respuesta
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: messages,
            temperature: 0.7,
            max_tokens: 800,
            presence_penalty: 0.6,
            frequency_penalty: 0.3
        });

        // Guardar en Firestore
        try {
            await db.collection('chats').add({
                userId: req.user.uid,
                category,
                message,
                response: completion.choices[0].message.content,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('stats').doc('global').set({
                totalConsultas: admin.firestore.FieldValue.increment(1),
                ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (dbError) {
            console.error('Error al guardar en Firestore:', dbError);
            // Continuar aunque falle el guardado
        }

        const processingTime = Date.now() - startTime;
        console.log(`Respuesta generada en ${processingTime}ms`);

        return res.json({ 
            response: completion.choices[0].message.content,
            processingTime
        });

    } catch (error) {
        console.error('Error en chatWithAI:', error);
        
        // Manejar diferentes tipos de errores
        if (error.code === 'context_length_exceeded') {
            return res.status(400).json({
                error: 'Mensaje demasiado largo',
                details: 'El mensaje excede el límite permitido'
            });
        }
        
        if (error.code === 'rate_limit_exceeded') {
            return res.status(429).json({
                error: 'Demasiadas solicitudes',
                details: 'Por favor, espere un momento antes de intentar nuevamente'
            });
        }

        return res.status(500).json({
            error: 'Error al procesar la consulta',
            details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno del servidor'
        });
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

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({
        error: 'Error interno del servidor',
        details: process.env.NODE_ENV === 'development' ? err.message : 'Ocurrió un error inesperado'
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});