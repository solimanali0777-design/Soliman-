const $ = (selector) => document.querySelector(selector);
const thread = $('#thread');
const promptBox = $('#prompt');
const sendBtn = $('#sendBtn');
const micBtn = $('#micBtn');
const statusText = $('#statusText');
const livingCore = $('#livingCore');
const providerPill = $('#providerPill');
const memoryPill = $('#memoryPill');
const notice = $('#notice');

const MEMORY_KEY = 'soly-cognitive-v2-memory';
let mode = 'chat';
let state = 'idle';
let providerConfigured = false;
let recognition = null;
const history = [];

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readMemory() {
  const raw = localStorage.getItem(MEMORY_KEY);
  const parsed = raw ? safeJson(raw, []) : [];
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function remember(text) {
  const clean = String(text || '').trim();
  const current = readMemory();
  if (clean.length < 15) return current;
  const next = [clean, ...current.filter((item) => item !== clean)].slice(0, 24);
  localStorage.setItem(MEMORY_KEY, JSON.stringify(next));
  updateMemoryPill();
  return next;
}

function updateMemoryPill() {
  memoryPill.textContent = 'ذاكرة: ' + readMemory().length;
}

function setState(next) {
  state = next;
  livingCore.className = 'core state-' + next;
  const labels = {
    idle: 'سولي حاضر ومستعد',
    listening: 'سولي بيسمعك بتركيز…',
    deep_thinking: 'سولي بيحلل ويربط السياق…',
    speaking: 'سولي بيتكلم دلوقتي…',
    generating_media: mode === 'video' ? 'سولي بيجهّز الفيديو…' : 'سولي بيبني الصورة…',
  };
  statusText.textContent = labels[next] || labels.idle;
  sendBtn.disabled = !promptBox.value.trim() || state !== 'idle';
}

function showNotice(message, kind = 'error', timeout = 6500) {
  notice.textContent = message;
  notice.className = 'notice ' + kind;
  if (timeout) {
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => {
      notice.className = 'notice hidden';
    }, timeout);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? safeJson(text, { message: text }) : {};
  if (!response.ok) {
    const error = new Error(data.message || 'حصل خطأ في الطلب.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function classifyError(error) {
  if (error?.status === 503) {
    return 'Render شغال، لكن محرك الذكاء الاصطناعي لسه مش متوصل. محتاج مفتاح المزود على السيرفر.';
  }
  if (error?.status === 402) {
    return 'الاستضافة شغالة، لكن مزود الذكاء الاصطناعي نفسه وصل لحد الرصيد.';
  }
  if (error?.status === 429) {
    return 'في طلبات كتير دلوقتي. استنى لحظة وجرب تاني.';
  }
  return error?.message || 'حصل خطأ غير متوقع.';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
  });
}

function addMessage(sender, text, media = {}) {
  const article = document.createElement('article');
  article.className = 'message ' + sender;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const p = document.createElement('p');
  p.innerHTML = escapeHtml(text).replaceAll('\n', '<br>');
  bubble.appendChild(p);

  if (media.imageUrl) {
    const img = document.createElement('img');
    img.src = media.imageUrl;
    img.alt = 'صورة مولدة بواسطة سولي';
    img.loading = 'lazy';
    bubble.appendChild(img);
  }

  if (media.videoUrl) {
    const video = document.createElement('video');
    video.src = media.videoUrl;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    bubble.appendChild(video);
  }

  if (sender === 'soly' && !media.imageUrl && !media.videoUrl) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'speak-btn';
    button.setAttribute('aria-label', 'اقرأ الرسالة بالصوت');
    button.textContent = '🔊';
    button.addEventListener('click', () => speak(text));
    bubble.appendChild(button);
  }

  article.appendChild(bubble);
  thread.appendChild(article);
  scrollToBottom();

  history.push({
    role: sender === 'soly' ? 'assistant' : 'user',
    content: text,
  });
  if (history.length > 24) history.splice(0, history.length - 24);
}

function updateModeButtons() {
  document.querySelectorAll('.mode').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  const placeholders = {
    chat: 'اسأل سولي في أي حاجة…',
    image: 'اوصف الصورة اللي عايزها بدقة…',
    video: 'اوصف مشهد الفيديو والحركة والكاميرا…',
  };
  promptBox.placeholder = placeholders[mode];
}

async function refreshStatus() {
  try {
    const data = await fetch('/api/status').then((response) => response.json());
    providerConfigured = Boolean(data.providerConfigured);
    providerPill.textContent = providerConfigured ? 'المحرك متصل' : 'المحرك غير متصل';
    providerPill.className = 'pill ' + (providerConfigured ? 'online' : 'offline');
    if (!providerConfigured) {
      showNotice('Render شغال بنجاح. محرك الذكاء الاصطناعي محتاج يتوصل بمفتاح Provider على السيرفر.', 'warning', 9000);
    }
  } catch {
    providerPill.textContent = 'فحص المحرك فشل';
    providerPill.className = 'pill offline';
  }
}

async function sendChat(text) {
  setState('deep_thinking');
  const data = await api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: text,
      history: history.slice(-16),
      memory: readMemory(),
    }),
  });
  addMessage('soly', data.reply || 'وصل الرد من غير نص.');
}

async function sendImage(text) {
  setState('generating_media');
  const data = await api('/api/image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: text,
      aspect: '1:1',
    }),
  });
  addMessage('soly', 'الصورة اتولدت من وصفك.', { imageUrl: data.imageUrl });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendVideo(text) {
  setState('generating_media');
  const started = await api('/api/video', {
    method: 'POST',
    body: JSON.stringify({
      prompt: text,
      aspect: '9:16',
      resolution: '720p',
      duration: 6,
      generateAudio: true,
    }),
  });

  const id = started.requestId;
  if (!id) throw new Error('محرك الفيديو ما رجعش رقم متابعة.');

  showNotice('بدأ توليد الفيديو. سولي بيتابع النتيجة تلقائيًا…', 'info', 0);

  for (let attempt = 0; attempt < 36; attempt += 1) {
    await wait(5000);
    const status = await api('/api/video?requestId=' + encodeURIComponent(id), {
      method: 'GET',
      headers: {},
    });
    const normalized = String(status.status || '').toLowerCase();
    if (normalized === 'done' || normalized === 'completed' || status.videoUrl) {
      notice.className = 'notice hidden';
      addMessage('soly', 'الفيديو خلص واتجهز.', { videoUrl: status.videoUrl });
      return;
    }
    if (['failed', 'expired', 'error'].includes(normalized)) {
      throw new Error('توليد الفيديو وقف قبل ما يكتمل.');
    }
  }

  throw new Error('الفيديو أخد وقت أطول من المتوقع. جرّب بعد شوية.');
}

async function send() {
  const text = promptBox.value.trim();
  if (!text || state !== 'idle') return;

  promptBox.value = '';
  sendBtn.disabled = true;
  addMessage('user', text);
  remember(text);

  try {
    if (mode === 'image') await sendImage(text);
    else if (mode === 'video') await sendVideo(text);
    else await sendChat(text);
  } catch (error) {
    showNotice(classifyError(error), 'error', 9000);
  } finally {
    setState('idle');
  }
}

async function speak(text) {
  if (!text) return;

  try {
    setState('speaking');
    if (providerConfigured) {
      const data = await api('/api/tts', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (data.audio) {
        const audio = new Audio(data.audio);
        audio.onended = () => setState('idle');
        audio.onerror = () => browserSpeak(text);
        await audio.play();
        return;
      }
    }
    browserSpeak(text);
  } catch {
    browserSpeak(text);
  }
}

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) {
    showNotice('المتصفح الحالي ما بيدعمش قراءة النص بالصوت.', 'warning');
    setState('idle');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ar-EG';
  utterance.rate = 0.95;
  utterance.onend = () => setState('idle');
  utterance.onerror = () => setState('idle');
  window.speechSynthesis.speak(utterance);
}

function startListening() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showNotice('التعرف الصوتي المباشر مش مدعوم في المتصفح ده.', 'warning');
    return;
  }

  if (recognition) {
    recognition.stop();
    return;
  }

  recognition = new Recognition();
  recognition.lang = 'ar-EG';
  recognition.continuous = false;
  recognition.interimResults = false;
  setState('listening');

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || '';
    promptBox.value = promptBox.value ? promptBox.value + ' ' + transcript : transcript;
    sendBtn.disabled = !promptBox.value.trim();
  };

  recognition.onerror = () => {
    showNotice('المايك ما قدرش يلتقط الكلام. تأكد من إذن الميكروفون وجرب تاني.', 'warning');
  };

  recognition.onend = () => {
    recognition = null;
    setState('idle');
  };

  recognition.start();
}

document.querySelectorAll('.mode').forEach((button) => {
  button.addEventListener('click', () => {
    mode = button.dataset.mode || 'chat';
    updateModeButtons();
    promptBox.focus();
  });
});

promptBox.addEventListener('input', () => {
  sendBtn.disabled = !promptBox.value.trim() || state !== 'idle';
});

promptBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

sendBtn.addEventListener('click', send);
micBtn.addEventListener('click', startListening);

document.querySelectorAll('[data-speak]').forEach((button) => {
  button.addEventListener('click', () => speak(button.dataset.speak || ''));
});

updateMemoryPill();
updateModeButtons();
setState('idle');
refreshStatus();
