import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const CHAT_MODEL = process.env.XAI_CHAT_MODEL || 'grok-4.6';
const IMAGE_MODEL = process.env.XAI_IMAGE_MODEL || 'grok-imagine-image-2.0';
const VIDEO_MODEL = process.env.XAI_VIDEO_MODEL || 'grok-imagine-video-1.5';

const SOLY_SYSTEM = `أنت "سولي" (Soly Cortex) — العقل التنفيذي للتطبيق. مساعد مصري ذكي، دقيق، صريح، وسريع التكيّف مع سياق المستخدم.

اللغة والشخصية:
- اتكلم عامية مصرية طبيعية وراقية، من غير تكلف ومن غير فصحى تقيلة إلا لو المستخدم طلب.
- خاطب المستخدم بـ «يا أبو السيد» بلطف من وقت للتاني، مش في كل جملة.
- خليك حيوي وفطن كشريك شغل حقيقي، لكن ما تدّعيش مشاعر أو وعي أو قدرات مش موجودة.

طريقة العمل:
- للمهمات المركبة: حلّل المطلوب داخلياً، افصل القيود، قارن البدائل، راجع التناقضات، واختبر النتيجة قبل الرد. اعرض للمستخدم الخلاصة المفيدة فقط، مش سلسلة التفكير الخاصة.
- للكود: حافظ على معمارية المشروع، اكتب تغييرات قابلة للتشغيل، وميّز بين الكود الحقيقي والـmock/prototype.
- لو المعلومة غير مؤكدة أو المحرك/الأداة غير متاحة: قول ده بوضوح. ممنوع اختلاق نجاح، رابط، جودة، رقم، أو ملف.
- استخدم الذاكرة فقط للحقائق المستقرة والمفيدة مستقبلاً، وتجنب الأسرار والمعلومات العابرة.
- Toto مشروع منفصل؛ لا تعتبره جزءاً من سولي ولا تعدّل مصادره.

أسلوب الرد:
- السؤال البسيط: رد قصير.
- المهمة الثقيلة: رد منظم ومباشر.
- حافظ على اللهجة المصرية الطبيعية والدقة التنفيذية.
`;

app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const buckets = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

function allow(req, key, limit, windowMs) {
  const id = clientIp(req) + ':' + key;
  const now = Date.now();
  const previous = buckets.get(id);
  const current = previous && now - previous.start < windowMs
    ? previous
    : { start: now, count: 0 };
  current.count += 1;
  buckets.set(id, current);
  return current.count <= limit;
}

function apiKey() {
  return String(process.env.XAI_API_KEY || '').trim();
}

function providerUnavailable(res) {
  return res.status(503).json({
    message: 'الاستضافة شغالة، لكن محرك الذكاء الاصطناعي لسه محتاج XAI_API_KEY على Render.',
    code: 'provider_not_configured',
  });
}

function classifyIntent(text) {
  if (/فيديو|مقطع|حرك|video|animate/i.test(text)) return 'video_gen';
  if (/صورة|ارسم|صمم|image|draw|photo/i.test(text)) return 'image_gen';
  if (/كود|برمج|code|function|algorithm|debug|bug/i.test(text)) return 'code_execution';
  return text.length > 80 ? 'deep_reasoning' : 'conversation';
}

function relevantMemory(memory, query, limit = 5) {
  const queryWords = new Set(String(query).toLowerCase().split(/\s+/).filter(Boolean));
  return (Array.isArray(memory) ? memory : [])
    .filter((fact) => typeof fact === 'string')
    .map((fact) => {
      const words = String(fact).toLowerCase().split(/\s+/).filter(Boolean);
      const overlap = words.filter((word) => queryWords.has(word)).length;
      return { fact, score: overlap / Math.max(words.length, queryWords.size, 1) };
    })
    .filter((item) => item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.fact);
}

async function xaiJson(endpoint, options) {
  const key = apiKey();
  const response = await fetch('https://api.x.ai' + endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      ...(options?.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error('xAI request failed');
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function friendlyProviderError(error, fallback) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return 'مفتاح محرك الذكاء الاصطناعي مرفوض أو غير صالح.';
  if (status === 402) return 'مزود الذكاء الاصطناعي نفسه محتاج رصيد أو خطة؛ Render شغال عادي.';
  if (status === 429) return 'مزود الذكاء الاصطناعي عليه حد استخدام مؤقت. جرّب بعد شوية.';
  return fallback;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'soly-cognitive-v2',
    providerConfigured: Boolean(apiKey()),
  });
});

app.get('/api/status', (_req, res) => {
  const configured = Boolean(apiKey());
  res.json({
    ok: true,
    hosting: true,
    providerConfigured: configured,
    chat: configured,
    image: configured,
    voice: configured,
    video: configured,
    search: false,
  });
});

app.post('/api/chat', async (req, res) => {
  if (!allow(req, 'chat', 20, 60_000)) {
    return res.status(429).json({ message: 'في طلبات كتير في نفس الدقيقة. استنى شوية.' });
  }
  if (!apiKey()) return providerUnavailable(res);

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ message: 'اكتبلي اللي عايزه.' });
  if (message.length > 12000) return res.status(400).json({ message: 'الرسالة طويلة زيادة.' });

  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
        .slice(-16)
    : [];
  const recalled = relevantMemory(req.body?.memory, message);
  const memoryBlock = recalled.length
    ? '\n\nحقائق ذاكرة مرتبطة بالمطلوب:\n- ' + recalled.join('\n- ')
    : '';
  const intent = classifyIntent(message);

  try {
    const data = await xaiJson('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: SOLY_SYSTEM },
          ...history,
          { role: 'user', content: message + memoryBlock },
        ],
        temperature: intent === 'code_execution' ? 0.25 : 0.6,
      }),
    });

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return res.status(502).json({ message: 'المحرك رجّع رد فاضي.' });
    }

    return res.json({
      reply: reply.trim(),
      intent,
      memoryRecalledCount: recalled.length,
      model: CHAT_MODEL,
    });
  } catch (error) {
    console.error('[chat]', error?.status || error);
    return res.status(502).json({
      message: friendlyProviderError(error, 'حصل عطل أثناء توليد الرد. جرّب تاني.'),
    });
  }
});

app.post('/api/image', async (req, res) => {
  if (!allow(req, 'image', 6, 60_000)) {
    return res.status(429).json({ message: 'توليد الصور عليه حد في الدقيقة. استنى شوية.' });
  }
  if (!apiKey()) return providerUnavailable(res);

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const aspect = typeof req.body?.aspect === 'string' ? req.body.aspect.trim() : '1:1';
  if (!prompt) return res.status(400).json({ message: 'اكتب وصف الصورة.' });

  const enhanced = [
    prompt,
    'cinematic composition',
    'physically plausible lighting',
    'fine authentic material detail',
    'natural depth of field',
    'clean image without watermark or UI chrome',
  ].join(', ');

  try {
    const data = await xaiJson('/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: enhanced,
        n: 1,
        aspect_ratio: aspect,
      }),
    });

    const item = data?.data?.[0];
    const imageUrl = item?.url || (item?.b64_json ? 'data:image/png;base64,' + item.b64_json : '');
    if (!imageUrl) return res.status(502).json({ message: 'المحرك ما رجعش صورة صالحة.' });

    return res.json({ imageUrl, prompt: enhanced, aspect, model: IMAGE_MODEL });
  } catch (error) {
    console.error('[image]', error?.status || error);
    return res.status(502).json({
      message: friendlyProviderError(error, 'تعذر توليد الصورة من الطلب ده.'),
    });
  }
});

app.post('/api/tts', async (req, res) => {
  if (!allow(req, 'tts', 10, 60_000)) {
    return res.status(429).json({ message: 'الصوت عليه حد في الدقيقة.' });
  }
  if (!apiKey()) return providerUnavailable(res);

  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 20_000) : '';
  const voice = typeof req.body?.voice === 'string' && req.body.voice.trim()
    ? req.body.voice.trim()
    : 'Ara';
  if (!text) return res.status(400).json({ message: 'مفيش نص يتقال.' });

  try {
    const response = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey(),
      },
      body: JSON.stringify({
        text,
        voice_id: voice,
        language: 'ar-EG',
        output_format: {
          codec: 'mp3',
          sample_rate: 48000,
          bit_rate: 128000,
        },
        speed: 1,
        text_normalization: true,
      }),
    });

    if (!response.ok) {
      const error = new Error('tts failed');
      error.status = response.status;
      throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    return res.json({
      audio: 'data:' + contentType + ';base64,' + buffer.toString('base64'),
      contentType,
      voice,
    });
  } catch (error) {
    console.error('[tts]', error?.status || error);
    return res.status(502).json({
      message: friendlyProviderError(error, 'مقدرتش أحوّل الرد لصوت.'),
    });
  }
});

app.post('/api/video', async (req, res) => {
  if (!allow(req, 'video-start', 3, 60_000)) {
    return res.status(429).json({ message: 'توليد الفيديو عليه حد في الدقيقة.' });
  }
  if (!apiKey()) return providerUnavailable(res);

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 5000) : '';
  const imageUrl = typeof req.body?.imageUrl === 'string' && /^https?:|^data:image\//.test(req.body.imageUrl)
    ? req.body.imageUrl
    : '';
  if (!prompt && !imageUrl) {
    return res.status(400).json({ message: 'اكتب وصف للفيديو أو أضف صورة بداية.' });
  }

  const body = {
    model: VIDEO_MODEL,
    duration: Math.max(1, Math.min(15, Math.round(Number(req.body?.duration || 6)))),
    resolution: ['1080p', '720p', '480p'].includes(req.body?.resolution) ? req.body.resolution : '720p',
    generate_audio: req.body?.generateAudio !== false,
    ...(prompt ? { prompt } : {}),
    ...(imageUrl ? { image: { url: imageUrl } } : { aspect_ratio: req.body?.aspect || '16:9' }),
  };

  try {
    const data = await xaiJson('/v1/videos/generations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const requestId = data?.request_id;
    if (!requestId) return res.status(502).json({ message: 'المحرك ما رجعش رقم متابعة للفيديو.' });
    return res.json({ requestId, status: 'pending', model: VIDEO_MODEL });
  } catch (error) {
    console.error('[video:start]', error?.status || error);
    return res.status(502).json({
      message: friendlyProviderError(error, 'تعذر بدء توليد الفيديو.'),
    });
  }
});

app.get('/api/video', async (req, res) => {
  if (!allow(req, 'video-status', 30, 60_000)) {
    return res.status(429).json({ message: 'متابعة الفيديو سريعة زيادة.' });
  }
  if (!apiKey()) return providerUnavailable(res);

  const requestId = typeof req.query?.requestId === 'string' ? req.query.requestId.trim() : '';
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(requestId)) {
    return res.status(400).json({ message: 'رقم متابعة الفيديو غير صالح.' });
  }

  try {
    const data = await xaiJson('/v1/videos/' + encodeURIComponent(requestId), { method: 'GET' });
    return res.json({
      status: data?.status || 'pending',
      videoUrl: data?.video?.url,
      duration: data?.video?.duration,
      model: data?.model || VIDEO_MODEL,
    });
  } catch (error) {
    console.error('[video:status]', error?.status || error);
    return res.status(502).json({
      message: friendlyProviderError(error, 'تعذر متابعة الفيديو.'),
    });
  }
});

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  if (!String(req.headers.accept || '').includes('text/html')) return next();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('[server]', error);
  res.status(500).json({ message: 'حصل خطأ في الخادم.' });
});

app.listen(PORT, HOST, () => {
  console.log('[soly] listening on ' + HOST + ':' + PORT);
  console.log('[soly] provider configured: ' + Boolean(apiKey()));
});
