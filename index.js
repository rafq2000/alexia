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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function extractTextFromFile(file) {
  try {
    console.log('Procesando archivo:', file.originalname, file.mimetype);

    if (file.mimetype.startsWith('image/')) {
      console.log('Procesando imagen con OCR');
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
      console.log('Procesando PDF');
      const pdfData = await PDFParser(file.buffer);
      return pdfData.text;

    } else {
      console.log('Procesando como texto plano');
      return file.buffer.toString('utf-8');
    }
  } catch (error) {
    console.error('Error procesando archivo:', error);
    throw new Error(`Error procesando ${file.originalname}: ${error.message}`);
  }
}

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

app.post('/api/chatWithAI', authenticateUser, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { message, category, conversationHistory = [] } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        error: 'Mensaje faltante',
        details: 'Se requiere un mensaje para procesar'
      });
    }

    let systemContent = `Eres un asistente legal especializado en temas de deudas y documentos legales.
                        Debes responder de manera clara y precisa, utilizando términos simples y explicando 
                        cualquier término legal que uses. Si no tienes suficiente información para dar una 
                        respuesta precisa, solicita más detalles. Si la consulta está fuera de tu ámbito de 
                        conocimiento, indícalo claramente.`;
    
    let messages = [
      { role: 'system', content: systemContent },
      ...conversationHistory.slice(-5),
      { role: 'user', content: message.trim() }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.7,
      max_tokens: 800,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    }).catch(error => {
      console.error('Error de OpenAI:', error);
      throw new Error('Error al procesar la consulta con IA');
    });

    const responseContent = completion.choices[0].message.content;

    // Guardar en Firestore de manera asíncrona
    Promise.all([
      admin.firestore().collection('chats').add({
        userId: req.user.uid,
        category,
        message: message.trim(),
        response: responseContent,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      }),
      admin.firestore().collection('stats').doc('global').set({
        totalConsultas: admin.firestore.FieldValue.increment(1),
        ultimaActualizacion: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true })
    ]).catch(error => {
      console.error('Error al guardar en Firestore:', error);
    });

    return res.json({
      response: responseContent,
      processingTime: Date.now() - startTime
    });

  } catch (error) {
    console.error('Error en chatWithAI:', error);
    
    return res.status(error.status || 500).json({
      error: 'Error al procesar la consulta',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Error interno',
      retryable: true
    });
  }
});

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

app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Error interno del servidor'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
});