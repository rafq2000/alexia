const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

// Ruta para las variables de entorno del cliente
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

// Configuraciones y middleware
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5000',
        'http://localhost',
        'https://alexia.onrender.com'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// El resto de tu código de index.js sigue igual...

// Contenido de leyes
const lawsContent = {
    ley20720: `
        LEY 20720 - LEY DE REORGANIZACIÓN Y LIQUIDACIÓN
        TÍTULO I - Disposiciones Generales
        Artículo 1.- La presente ley establece el régimen general de los procedimientos de reorganización y liquidación...
        Artículo 2.- La finalidad de esta ley es permitir la reorganización de las empresas...
    `,
    ley21484: `
        LEY 21484 - SISTEMA DE GARANTÍAS DE LA NIÑEZ
        TÍTULO I - Disposiciones Generales
        Artículo 1.- Se reconoce a los niños, niñas y adolescentes el derecho a vivir en un entorno seguro...
        Artículo 2.- Las entidades públicas deben garantizar la protección de los menores...
    `,
    codigoProcedimientoCivil: `
        CÓDIGO DE PROCEDIMIENTO CIVIL
        LIBRO PRIMERO - De los juicios en general
        Artículo 1.- Este código regula los procedimientos civiles y establece las reglas básicas de la administración judicial...
        Artículo 2.- Todo juicio debe garantizar el debido proceso...
    `,
    codigoCivil: `
        CÓDIGO CIVIL
        TÍTULO PRELIMINAR - De la ley
        Artículo 1.- La ley es una declaración de la voluntad soberana que, manifestada en la forma prescrita por la Constitución...
        Artículo 2.- La ignorancia de la ley no sirve de excusa para su incumplimiento...
    `
};

// Inicialización de Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado correctamente.");
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
}

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
console.log("OpenAI inicializado correctamente.");


// Middlewares
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5000',
        'http://localhost',
        'https://alexia.onrender.com'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rutas principales
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Middleware de autenticación de Firebase
const authenticateFirebase = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.error('No se proporcionó token válido');
        return res.status(403).json({ 
            error: 'No token provided',
            details: 'Authorization header is missing or invalid'
        });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Error de autenticación:', error);
        res.status(403).json({ 
            error: 'Unauthorized',
            details: error.message
        });
    }
};

// Ruta para chat con IA
app.post('/chatWithAI', authenticateFirebase, async (req, res) => {
    try {
        console.log('Solicitud recibida:', req.body);
        console.log('Usuario autenticado:', req.user);

        const { message, model = 'gpt-4', temperature = 0.7, max_tokens = 500 } = req.body;

        if (!message) {
            console.error('No se proporcionó el mensaje');
            return res.status(400).json({ error: 'No message provided' });
        }

        const legalContext = Object.values(lawsContent).join('\n\n');
        console.log('Enviando solicitud a OpenAI...');

        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'system',
                    content: `Eres un asistente legal especializado en asesoría legal chilena.
Conoces a fondo las siguientes leyes:
${legalContext}

Directrices:
- Proporciona información legal precisa
- Explica conceptos legales de manera clara
- Ofrece orientación basada en la legislación chilena
- Si no estás seguro, admítelo honestamente`
                },
                { role: 'user', content: message }
            ],
            temperature: temperature,
            max_tokens: max_tokens
        });

        const aiResponseContent = completion.choices[0].message.content;
        console.log('Respuesta de OpenAI:', aiResponseContent);

        res.json({ response: aiResponseContent });
    } catch (error) {
        console.error('Error en /chatWithAI:', error);
        res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            fullError: JSON.stringify(error)
        });
    }
});

// Ruta catch-all para el SPA
app.get('*', (req, res) => {
    res.redirect('/');
});

// Configuración del puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    console.log('OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Está cargada' : 'No está cargada');
});