/*******************************************
 *         index.js CORREGIDO (Node)       *
 *******************************************/
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

// NUEVAS DEPENDENCIAS para análisis de archivos
const multer = require('multer');
const Tesseract = require('tesseract.js');
const PDFParser = require('pdf-parse');
const sharp = require('sharp');

dotenv.config();

const app = express();

// 1. Inicialización de Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin inicializado correctamente");
} catch (error) {
  console.error("Error al inicializar Firebase Admin:", error);
  process.exit(1); // Termina si Firebase no se inicializa correctamente
}

// 2. Inicialización de Firestore
const db = admin.firestore();

// 3. Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. Configuración de env para el cliente
app.get('/env-config.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  const envVars = {
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || '',
    FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || '',
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
    FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || '',
  };
  res.send(`window.ENV = ${JSON.stringify(envVars)};`);
});

// 5. Inicialización de OpenAI (versión corregida)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 6. Middleware de autenticación
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Token no proporcionado',
        details: 'Se requiere un token de autenticación válido',
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
        details: 'El token proporcionado no es válido o ha expirado',
      });
    }
  } catch (error) {
    console.error('Error en autenticación:', error);
    return res.status(500).json({
      error: 'Error de autenticación',
      details: 'Error interno en el proceso de autenticación',
    });
  }
};

// 7. Ruta de verificación de salud del servidor
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 8. Ruta del chat mejorada
app.post('/api/chatWithAI', authenticateUser, async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, category, conversationHistory = [] } = req.body;

    if (!message) {
      return res.status(400).json({
        error: 'Mensaje faltante',
        details: 'Se requiere un mensaje para procesar',
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
      { role: 'system', content: systemContent },
    ];

    // Agregar historial de conversación si existe (últimos 5)
    if (conversationHistory.length > 0) {
      messages = [...messages, ...conversationHistory.slice(-5)];
    }

    // Agregar mensaje actual
    messages.push({ role: 'user', content: message });

    // Generar respuesta con la API de OpenAI (versión corregida)
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: messages,
      temperature: 0.7,
      max_tokens: 800,
      presence_penalty: 0.6,
      frequency_penalty: 0.3,
    });

    const responseContent = completion.choices[0].message.content;

    // Guardar en Firestore
    try {
      await db.collection('chats').add({
        userId: req.user.uid,
        category,
        message,
        response: responseContent,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('stats').doc('global').set(
        {
          totalConsultas: admin.firestore.FieldValue.increment(1),
          ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (dbError) {
      console.error('Error al guardar en Firestore:', dbError);
      // Continuar aunque falle el guardado
    }

    const processingTime = Date.now() - startTime;
    console.log(`Respuesta generada en ${processingTime}ms`);

    return res.json({
      response: responseContent,
      processingTime,
    });
  } catch (error) {
    console.error('Error en chatWithAI:', error);

    // Manejar diferentes tipos de errores específicos
    if (error.code === 'context_length_exceeded') {
      return res.status(400).json({
        error: 'Mensaje demasiado largo',
        details: 'El mensaje excede el límite permitido',
      });
    }

    if (error.code === 'rate_limit_exceeded') {
      return res.status(429).json({
        error: 'Demasiadas solicitudes',
        details: 'Por favor, espere un momento antes de intentar nuevamente',
      });
    }

    return res.status(500).json({
      error: 'Error al procesar la consulta',
      details:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Error interno del servidor',
    });
  }
});

/* ========================= NUEVA FUNCIONALIDAD DE ANALIZAR DOCUMENTOS ========================= */

// Configuración de multer para archivos (memoria)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: undefined // Sin límite explícito
  }
});

// Función para procesar diferentes tipos de archivos
async function extractTextFromFile(file) {
  const mimeType = file.mimetype;
  let text = '';

  try {
    if (mimeType.startsWith('image/')) {
      // Procesar imagen con Sharp y OCR con Tesseract
      const optimizedBuffer = await sharp(file.buffer)
        .resize(3000, 3000, { fit: 'inside' })
        .normalize()
        .sharpen()
        .toBuffer();

      const result = await Tesseract.recognize(optimizedBuffer, 'spa+eng', {
        logger: m => console.log(m)
      });
      text = result.data.text;
    } else if (mimeType === 'application/pdf') {
      // Procesar PDF con pdf-parse
      const pdfData = await PDFParser(file.buffer);
      text = pdfData.text;
    } else if (mimeType.startsWith('text/')) {
      // Archivos de texto plano
      text = file.buffer.toString('utf-8');
    } else {
      // Otros tipos (docx, etc.) -> se intenta leer como binario
      text = file.buffer.toString('utf-8');
    }

    return text;
  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw error;
  }
}

// Ruta para análisis de documentos
app.post('/api/analyzeDocument', authenticateUser, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Documento no proporcionado',
        details: 'Se requiere un archivo para analizar'
      });
    }

    console.log(`Procesando documento: ${req.file.originalname} (${req.file.mimetype})`);
    const documentText = await extractTextFromFile(req.file);

    if (!documentText || documentText.trim().length === 0) {
      return res.status(400).json({
        error: 'No se pudo extraer texto',
        details: 'No se pudo extraer texto del documento proporcionado'
      });
    }

    const userQuery = req.body.query || "Por favor, explica este documento en términos simples.";

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en explicar documentos legales en términos simples. 
                    Tu tarea es:
                    1. Analizar el contenido del documento
                    2. Identificar el tipo de documento (contrato, resolución, etc.)
                    3. Explicar los puntos principales en lenguaje simple
                    4. Resaltar cualquier término o cláusula importante
                    5. Identificar plazos o fechas importantes si existen
                    6. Explicar las obligaciones y derechos principales
                    7. Responder específicamente a la consulta del usuario si la hay

                    Usa un lenguaje claro y sencillo, evitando jerga legal cuando sea posible.
                    Si encuentras términos técnicos, explícalos.
                    Si hay algo crítico o que requiera atención inmediata, destácalo.`
        },
        {
          role: 'user',
          content: `Documento a analizar:\n\n${documentText}\n\nPregunta del usuario: ${userQuery}`
        }
      ],
      temperature: 0.7,
      max_tokens: 2500
    });

    // Guardar en Firestore
    await db.collection('documentAnalysis').add({
      userId: req.user.uid,
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      query: userQuery,
      response: completion.choices[0].message.content,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      response: completion.choices[0].message.content,
      documentType: req.file.mimetype,
      fileName: req.file.originalname
    });
  } catch (error) {
    console.error('Error al analizar documento:', error);
    return res.status(500).json({
      error: 'Error al procesar el documento',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno del servidor'
    });
  }
});

/* ================== FIN NUEVA FUNCIONALIDAD ================== */

// 9. Rutas principales
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

// NUEVA RUTA para página "document-chat"
app.get('/document-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/document-chat.html'));
});

// 10. Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'Ocurrió un error inesperado',
  });
});

// 11. Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
