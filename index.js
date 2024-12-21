/*******************************************
 *         index.js COMPLETO (Node)        *
 *******************************************/
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');
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
  process.exit(1);
}

// 2. Configuración de multer para archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  }
});

// 3. Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 4. Inicialización de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 5. Función para extraer texto de archivos
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
    } 
    else if (mimeType === 'application/pdf') {
      const pdfData = await PDFParser(file.buffer);
      text = pdfData.text;
    } 
    else if (mimeType.startsWith('text/')) {
      text = file.buffer.toString('utf-8');
    }
    else {
      text = file.buffer.toString('utf-8');
    }

    return text.trim();
  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw error;
  }
}

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

// 7. Rutas

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

// Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ruta para chat general
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

    let systemContent = `Eres un asistente legal especializado en temas de deudas y documentos legales.`;
    let messages = [{ role: 'system', content: systemContent }];

    if (conversationHistory.length > 0) {
      messages = [...messages, ...conversationHistory.slice(-5)];
    }
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

    return res.json({
      response: responseContent,
      processingTime: Date.now() - startTime
    });
  } catch (error) {
    console.error('Error en chatWithAI:', error);
    return res.status(500).json({
      error: 'Error al procesar la consulta',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno'
    });
  }
});

// Ruta para análisis de documentos
app.post('/api/analyzeDocument', authenticateUser, upload.array('document'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'Documento no proporcionado',
        details: 'Se requiere al menos un archivo para analizar'
      });
    }

    console.log(`Procesando ${req.files.length} documento(s)`);
    let allText = '';

    for (const file of req.files) {
      console.log(`Procesando: ${file.originalname} (${file.mimetype})`);
      try {
        const documentText = await extractTextFromFile(file);
        if (documentText && documentText.trim()) {
          allText += `\n\n=== Contenido de ${file.originalname} ===\n${documentText}`;
        }
      } catch (error) {
        console.error(`Error procesando archivo ${file.originalname}:`, error);
      }
    }

    if (!allText.trim()) {
      return res.status(400).json({
        error: 'No se pudo extraer texto',
        details: 'No se pudo extraer texto legible de los documentos proporcionados'
      });
    }

    const userQuery = req.body.query || "Por favor, explica este documento en términos simples.";

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en explicar documentos legales en términos sencillos.
                   Tu tarea es:
                   1. Analizar el contenido proporcionado
                   2. Explicar en lenguaje simple y claro los puntos principales
                   3. Identificar fechas o plazos importantes
                   4. Explicar términos legales de forma comprensible
                   5. Responder específicamente a la consulta del usuario

                   Al final de CADA respuesta, incluye SIEMPRE este mensaje:
                   "NOTA IMPORTANTE: Para recibir asesoría legal personalizada sobre este documento, 
                   te recomiendo consultar con uno de nuestros abogados especialistas. 
                   Haz clic en el ícono de WhatsApp para contactar a un profesional ahora mismo."`
        },
        {
          role: 'user',
          content: `Documentos a analizar:\n${allText}\n\nConsulta específica: ${userQuery}`
        }
      ],
      temperature: 0.7,
      max_tokens: 2500
    });

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

app.get('/document-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/document-chat.html'));
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Error interno del servidor'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});