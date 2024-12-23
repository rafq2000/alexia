/*******************************************
 *        index.js con ajustes de seguridad
 *******************************************/
const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const hpp = require('hpp');
const xssClean = require('xss-clean');
const rateLimit = require('express-rate-limit');
const csurf = require('csurf');
const { body, validationResult } = require('express-validator'); // ejemplo de uso con express-validator

// Paquetes de Firebase y OpenAI
const admin = require('firebase-admin');
const OpenAI = require('openai');

// Subida y manipulación de archivos
const multer = require('multer');
const Tesseract = require('tesseract.js');
const PDFParser = require('pdf-parse');
const sharp = require('sharp');

// Cargar variables de entorno
dotenv.config();

// ----------------------------------------
//  1. Inicializar Express
// ----------------------------------------
const app = express();

// ----------------------------------------
//  2. Configuración de seguridad
// ----------------------------------------

// Helmet para cabeceras seguras
app.use(helmet());

// Evitar inyección de parámetros repetidos
app.use(hpp());

// Limpiar inputs de posibles ataques XSS
app.use(xssClean());

// CORS básico (ajusta según tu dominio)
app.use(cors());

// Límite de peticiones (ejemplo: 100/minuto)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, 
  message: {
    error: 'Demasiadas peticiones, por favor intenta de nuevo más tarde.',
  },
});
app.use(limiter);

// CSRF (requiere que tu front envíe token, o usar cookies y plantillas):
// const csrfProtection = csurf({ cookie: true });
// app.use(csrfProtection); 
// Nota: Para APIs con JWT, a veces no se usa CSRF. Ajusta a tus necesidades.

// ----------------------------------------
//  3. Inicialización de Firebase Admin
// ----------------------------------------
try {
  // Lee la cuenta de servicio desde la variable de entorno
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin inicializado correctamente");
} catch (error) {
  console.error("Error al inicializar Firebase Admin:", error);
  process.exit(1);
}

// ----------------------------------------
//  4. Configuración de Express
// ----------------------------------------
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Archivos estáticos (HTML, CSS, JS del cliente)
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------
//  5. Configuración de multer (20MB máx.)
// ----------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ----------------------------------------
//  6. Inicialización de OpenAI
// ----------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ----------------------------------------
//  7. Función para extraer texto de archivos
// ----------------------------------------
async function extractTextFromFile(file) {
  try {
    console.log('Procesando archivo:', file.originalname, file.mimetype);

    if (file.mimetype.startsWith('image/')) {
      // Procesar imagen con Tesseract
      const optimizedBuffer = await sharp(file.buffer)
        .resize(2000, 2000, { fit: 'inside' })
        .normalize()
        .sharpen()
        .toBuffer();

      const result = await Tesseract.recognize(optimizedBuffer, 'spa+eng', {
        logger: m => console.log('Tesseract:', m)
      });
      return result.data.text;

    } else if (file.mimetype === 'application/pdf') {
      // Procesar PDF con pdf-parse
      const pdfData = await PDFParser(file.buffer);
      return pdfData.text;

    } else {
      // Procesar como texto plano
      return file.buffer.toString('utf-8');
    }

  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw new Error(`Error procesando ${file.originalname}: ${error.message}`);
  }
}

// ----------------------------------------
//  8. Middleware de autenticación (JWT Firebase)
// ----------------------------------------
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
      req.user = decodedToken; // Guardamos info del usuario en req
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

// ----------------------------------------
//  9. Rutas principales
// ----------------------------------------

// 9.1 Env-config (para exponer ciertas vars al frontend)
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

// 9.2 Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 9.3 (Opcional) Ejemplo con express-validator 
//     - Revisa que exista 'message' y que su longitud sea > 5
app.post('/api/checkMessage',
  body('message').isLength({ min: 5 }).withMessage('El mensaje debe tener al menos 5 caracteres'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    return res.json({ success: true, data: req.body.message });
  }
);

// 9.4 Ruta para chat general con OpenAI
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

    // Limitar el historial a las últimas 5 entradas
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

    // Guardar en Firestore
    try {
      await admin.firestore().collection('chats').add({
        userId: req.user.uid,
        category,
        message,
        response: responseContent,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Actualizar stats (ejemplo)
      await admin.firestore().collection('stats').doc('global').set({
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

// 9.5 Ruta para analizar documentos
app.post('/api/analyzeDocument', authenticateUser, upload.array('document'), async (req, res) => {
  try {
    console.log('Iniciando análisis de documentos');
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No se proporcionaron documentos',
        details: 'Por favor, selecciona al menos un archivo'
      });
    }

    let allText = '';
    for (const file of req.files) {
      try {
        const text = await extractTextFromFile(file);
        if (text && text.trim()) {
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

    console.log('Texto extraído, enviando a OpenAI');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente legal especializado en explicar documentos en términos simples.
                    Analiza el texto proporcionado y:
                     1. Identifica el tipo de documento
                     2. Explica su contenido en términos simples
                     3. Destaca puntos importantes
                     4. Menciona fechas o plazos relevantes
                     
                     Termina SIEMPRE con:
                     "Para recibir asesoría legal personalizada sobre este documento, haz clic en el ícono de WhatsApp para contactar a un abogado especialista."`
        },
        {
          role: 'user',
          content: `Analiza este texto:\n${allText}`
        }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    console.log('Respuesta recibida de OpenAI');

    return res.json({
      response: completion.choices[0].message.content
    });

  } catch (error) {
    console.error('Error en análisis:', error);
    return res.status(500).json({
      error: 'Error al procesar los documentos',
      details: error.message
    });
  }
});

// 9.6 Rutas de frontend
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

// ----------------------------------------
// Manejo de errores global
// ----------------------------------------
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Error interno del servidor'
  });
});

// ----------------------------------------
// Iniciar servidor
// ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
