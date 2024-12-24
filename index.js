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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
const hpp = require('hpp');
const { validationResult, check } = require('express-validator');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

dotenv.config();

const app = express();

// Inicialización de Firebase Admin
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

// Configuración de multer para archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
    files: 3
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf', 'text/plain'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido'), false);
    }
    cb(null, true);
  }
});

// Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://www.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'"]
    }
  }
}));
app.use(xss());
app.use(hpp());
app.use(compression());
app.use(mongoSanitize());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes, intente más tarde' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Inicialización de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Función para extraer texto de archivos
async function extractTextFromFile(file) {
  try {
    console.log('Procesando archivo:', file.originalname, file.mimetype);

    if (file.mimetype.startsWith('image/')) {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(2000, 2000, { fit: 'inside' })
        .normalize()
        .sharpen()
        .toBuffer();

      const result = await Tesseract.recognize(optimizedBuffer, 'spa+eng', {
        logger: m => console.log('Tesseract:', m)
      });
      return result.data.text;
    } 
    
    if (file.mimetype === 'application/pdf') {
      const pdfData = await PDFParser(file.buffer);
      return pdfData.text;
    }

    return file.buffer.toString('utf-8');
  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw new Error(`Error procesando ${file.originalname}: ${error.message}`);
  }
}

// Middleware de autenticación
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

// Validaciones
const validateChat = [
  check('message').trim().notEmpty().withMessage('El mensaje es requerido'),
  check('category').trim().notEmpty().withMessage('La categoría es requerida')
];

// Cache control middleware
const cacheControl = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// Rutas
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/chatWithAI', [authenticateUser, validateChat, cacheControl], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const startTime = Date.now();
  try {
    const { message, category, conversationHistory = [] } = req.body;
    
    // Limitar historial
    const limitedHistory = conversationHistory.slice(-8);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en temas de deudas y documentos legales en Chile.
                   Proporciona respuestas precisas y prácticas basadas en la legislación chilena actual.
                   Enfócate en dar soluciones claras y comprensibles para el usuario.
                   Incluye referencias a leyes y normativas cuando sea relevante.`
        },
        ...limitedHistory,
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 1500,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    });

    // Guardar en Firestore
    try {
      const batch = admin.firestore().batch();
      
      const chatRef = admin.firestore().collection('chats').doc();
      batch.set(chatRef, {
        userId: req.user.uid,
        category,
        message,
        response: completion.choices[0].message.content,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        processingTime: Date.now() - startTime
      });

      const statsRef = admin.firestore().collection('stats').doc('global');
      batch.set(statsRef, {
        totalConsultas: admin.firestore.FieldValue.increment(1),
        ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await batch.commit();
    } catch (dbError) {
      console.error('Error Firestore:', dbError);
      // Continue despite DB error
    }

    return res.json({
      response: completion.choices[0].message.content,
      processingTime: Date.now() - startTime
    });
  } catch (error) {
    console.error('Error en chatWithAI:', error);
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Límite de solicitudes excedido',
        details: 'Por favor, intente más tarde'
      });
    }
    return res.status(500).json({
      error: 'Error al procesar la consulta',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno'
    });
  }
});

app.post('/api/analyzeDocument', [authenticateUser, cacheControl], upload.array('document'), async (req, res) => {
  try {
    console.log('Iniciando análisis de documentos');
    
    if (!req.files?.length) {
      return res.status(400).json({
        error: 'No se proporcionaron documentos',
        details: 'Por favor, selecciona al menos un archivo'
      });
    }

    let allText = '';
    for (const file of req.files) {
      try {
        const text = await extractTextFromFile(file);
        if (text?.trim()) {
          allText += `\n--- ${file.originalname} ---\n${text.trim()}\n`;
        }
      } catch (error) {
        console.error(`Error procesando ${file.originalname}:`, error);
      }
    }

    if (!allText.trim()) {
      return res.status(400).json({
        error: 'No se pudo extraer texto',
        details: 'No se pudo extraer texto legible de los documentos'
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en analizar documentos legales chilenos.
                   Para cada documento:
                   1. Identifica el tipo y naturaleza del documento
                   2. Resume los puntos principales y obligaciones
                   3. Destaca fechas, plazos y términos importantes
                   4. Señala cualquier cláusula o aspecto legal relevante
                   5. Indica si requiere atención urgente o acciones inmediatas
                   6. Menciona posibles riesgos o consideraciones legales
                   
                   Usa un lenguaje claro y comprensible, explicando términos legales cuando sea necesario.
                   
                   Termina con:
                   "Para recibir asesoría legal personalizada sobre este documento, contacta a un abogado especialista mediante el ícono de WhatsApp."`
        },
        {
          role: 'user',
          content: `Analiza este texto:\n${allText}`
        }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    // Guardar análisis en Firestore
    try {
      await admin.firestore().collection('documentAnalysis').add({
        userId: req.user.uid,
        filesAnalyzed: req.files.map(f => f.originalname),
        response: completion.choices[0].message.content,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (dbError) {
      console.error('Error al guardar análisis:', dbError);
    }

    return res.json({
      response: completion.choices[0].message.content
    });
  } catch (error) {
    console.error('Error en análisis:', error);
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Límite de solicitudes excedido',
        details: 'Por favor, intente más tarde'
      });
    }
    return res.status(500).json({
      error: 'Error al procesar los documentos',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno'
    });
  }
});

// Rutas principales con cache control
app.get('/', cacheControl, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/menu', cacheControl, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.html'));
});

app.get('/chat', cacheControl, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

app.get('/document-chat', cacheControl, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/document-chat.html'));
});

// Error 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    details: 'La página solicitada no existe'
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  
  // Manejo específico para errores de multer
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'Archivo demasiado grande',
        details: 'El tamaño máximo permitido es 20MB'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Demasiados archivos',
        details: 'Máximo 3 archivos permitidos'
      });
    }
  }

  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Error interno'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  consoleconsole.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Manejo de señales de terminación
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}. Graceful shutdown initiated...`);
      server.close(() => {
        console.log('Server closed');
        admin.app().delete().then(() => {
          console.log('Firebase Admin terminated');
          process.exit(0);
        });
      });
    });
  });
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});