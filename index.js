/*******************************************
 *         index.js CORREGIDO (Node)       *
 *******************************************/
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

// Dependencias para análisis de archivos
const multer = require('multer');
const Tesseract = require('tesseract.js');
const PDFParser = require('pdf-parse');
const sharp = require('sharp');

dotenv.config();

const app = express();

// 1. Inicializar Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin inicializado correctamente");
} catch (error) {
  console.error("Error al inicializar Firebase Admin:", error);
  process.exit(1);
}

// 2. Firestore
const db = admin.firestore();

// 3. Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
    FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || ''
  };
  res.send(`window.ENV = ${JSON.stringify(envVars)};`);
});

// 5. OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 6. Middleware de autenticación
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

// 7. Ruta de verificación de salud
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 8. Ruta del chat
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

    console.log(`Procesando mensaje para usuario ${req.user.uid}, categoría: ${category}`);

    // Mensaje del sistema
    const systemContent = `Eres un asistente legal especializado en temas de deudas y documentos legales.`;
    let messages = [{ role: 'system', content: systemContent }];

    // Historial de conversación
    if (conversationHistory.length > 0) {
      messages = [...messages, ...conversationHistory.slice(-5)];
    }
    // Agregar mensaje actual
    messages.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.7,
      max_tokens: 800,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    });

    const responseContent = completion.choices[0].message.content;

    // Guardar en Firestore
    try {
      await db.collection('chats').add({
        userId: req.user.uid,
        category,
        message,
        response: responseContent,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      await db.collection('stats').doc('global').set({
        totalConsultas: admin.firestore.FieldValue.increment(1),
        ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (dbError) {
      console.error('Error al guardar en Firestore:', dbError);
    }

    const processingTime = Date.now() - startTime;
    console.log(`Respuesta generada en ${processingTime}ms`);

    return res.json({
      response: responseContent,
      processingTime
    });
  } catch (error) {
    console.error('Error en chatWithAI:', error);

    if (error.code === 'context_length_exceeded') {
      return res.status(400).json({ error: 'Mensaje demasiado largo' });
    }
    if (error.code === 'rate_limit_exceeded') {
      return res.status(429).json({ error: 'Demasiadas solicitudes' });
    }

    return res.status(500).json({
      error: 'Error al procesar la consulta',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno'
    });
  }
});

// 9. Configuración de multer para archivos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: undefined // Sin límite específico
  }
});

// 10. Función para procesar archivos
async function extractTextFromFile(file) {
  const mimeType = file.mimetype;
  let text = '';

  try {
    if (mimeType.startsWith('image/')) {
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
      const pdfData = await PDFParser(file.buffer);
      text = pdfData.text;

    } else if (mimeType.startsWith('text/')) {
      text = file.buffer.toString('utf-8');

    } else {
      text = file.buffer.toString('utf-8');
    }

    return text;
  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw error;
  }
}

// 11. Ruta para análisis de múltiples documentos
app.post('/api/analyzeDocument', authenticateUser, upload.array('document'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'Documento no proporcionado',
        details: 'Se requiere al menos un archivo para analizar'
      });
    }

    // Procesar todos los archivos
    let allText = '';
    for (const file of req.files) {
      console.log(`Procesando documento: ${file.originalname} (${file.mimetype})`);
      const documentText = await extractTextFromFile(file);
      allText += `\n\n=== ${file.originalname} ===\n${documentText}`;
    }

    if (!allText.trim()) {
      return res.status(400).json({
        error: 'No se pudo extraer texto',
        details: 'Los documentos proporcionados no contienen texto reconocible'
      });
    }

    const userQuery = req.body.query || "Por favor, explica estos documentos en términos simples.";

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en explicar documentos legales en términos sencillos.`
        },
        {
          role: 'user',
          content: `Documentos a analizar:\n${allText}\n\nPregunta del usuario: ${userQuery}`
        }
      ],
      temperature: 0.7,
      max_tokens: 2500
    });

    // Guardar en Firestore
    await db.collection('documentAnalysis').add({
      userId: req.user.uid,
      files: req.files.map(f => ({
        fileName: f.originalname,
        fileType: f.mimetype,
        fileSize: f.size
      })),
      query: userQuery,
      response: completion.choices[0].message.content,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      response: completion.choices[0].message.content,
      filesProcessed: req.files.map(f => f.originalname)
    });
  } catch (error) {
    console.error('Error al analizar documentos:', error);
    return res.status(500).json({
      error: 'Error al procesar los documentos',
      details: process.env.NODE_ENV === 'development'
        ? error.message
        : 'Error interno del servidor'
    });
  }
});

// 12. Rutas principales
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

app.get('/document-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/document-chat.html'));
});

// 13. Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Ocurrió un error inesperado'
  });
});

// 14. Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});