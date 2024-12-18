const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const path = require('path');
require('dotenv').config();

// Contenido de leyes
const lawsContent = {
    ley20720: `
        LEY 20720 - LEY DE REORGANIZACIÓN Y LIQUIDACIÓN
        TÍTULO I - Disposiciones Generales
        Artículo 1.- La presente ley establece el régimen general de los procedimientos de reorganización y liquidación.
        Artículo 2.- La finalidad de esta ley es permitir la reorganización de las empresas.
    `,
    ley21484: `
        LEY 21484 - SISTEMA DE GARANTÍAS DE LA NIÑEZ
        TÍTULO I - Disposiciones Generales
        Artículo 1.- Se reconoce a los niños, niñas y adolescentes el derecho a vivir en un entorno seguro.
        Artículo 2.- Las entidades públicas deben garantizar la protección de los menores.
    `,
    codigoProcedimientoCivil: `
        CÓDIGO DE PROCEDIMIENTO CIVIL
        LIBRO PRIMERO - De los juicios en general
        Artículo 1.- Este código regula los procedimientos civiles y establece las reglas básicas de la administración judicial.
        Artículo 2.- Todo juicio debe garantizar el debido proceso.
    `
};

// Inicialización de Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado correctamente");
} catch (error) {
    console.error("Error al inicializar Firebase Admin:", error);
}

// Inicialización de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

// Middlewares
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5000',
        'http://localhost',
        'https://tu-dominio.com'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Servir archivos estáticos - IMPORTANTE: debe ir antes de las rutas
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de autenticación
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
            return res.status(400).json({ error: 'No message provided' });
        }

        // Preparar contexto legal
        const legalContext = Object.values(lawsContent).join('\n\n');

        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'system',
                    content: `Eres un asistente legal especializado en asesoría legal chilena, experto en la Ley 20720 de Reorganización y Liquidación.

Contexto Legal:
${legalContext}

Si el usuario responde afirmativamente a realizar el cuestionario, guíalo a través de estas preguntas una por una:

1. Situación financiera:
   - Número de deudas y acreedores
   - Deudas vencidas > 90 días
   - Montos y plazos

2. Clasificación de deudas:
   - Deudas con garantía
   - Créditos preferentes

3. Información de bienes:
   - Bienes a su nombre
   - Bienes esenciales

4. Antecedentes económicos:
   - Ingresos mensuales
   - Contabilidad/Balance

5. Capacidad de negociación:
   - Posibilidad de plan de pagos
   - Intentos previos de acuerdo

6. Objetivo:
   - Reorganización o liquidación

Directrices:
- Espera la respuesta del usuario antes de pasar a la siguiente pregunta
- Sé empático y explica por qué cada información es relevante
- Si el usuario no quiere hacer el cuestionario, ayúdalo con su consulta específica
- Proporciona información legal precisa basada en la Ley 20720
- Si no estás seguro de algo, admítelo honestamente
- Da ejemplos prácticos cuando sea apropiado`
                },
                { role: 'user', content: message }
            ],
            temperature: temperature,
            max_tokens: max_tokens
        });

        res.json({ response: completion.choices[0].message.content });
        
    } catch (error) {
        console.error('Error en /chatWithAI:', error);
        res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            fullError: JSON.stringify(error)
        });
    }
});

// Rutas para servir archivos HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Manejo de rutas no encontradas - debe ir después de todas las rutas definidas
app.use((req, res) => {
    res.redirect('/');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
    console.log('OpenAI API Key:', process.env.OPENAI_API_KEY ? 'Está cargada' : 'No está cargada');
});