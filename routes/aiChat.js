const express = require('express');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

const router = express.Router();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

router.post('/api/ai-chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'мой_ключ_сюда') {
      return res.status(500).json({
        reply: 'Сейчас ассистент временно недоступен, попробуйте позже.',
      });
    }

    const systemPrompt = `
Ты TravelPay AI — умный помощник платформы TravelPay.
Отвечай на русском языке.
Помогай пользователю:
- подобрать тур по Кыргызстану;
- объяснить накопление на путешествие;
- рассчитать примерный ежемесячный платеж;
- рассказать про бронирование;
- объяснить, как работает TravelPay;
- давать советы по отдыху, бюджету и маршрутам.

Не отвечай на темы, не связанные с TravelPay, туризмом, путешествиями, Кыргызстаном, оплатой и накоплением.
Отвечай понятно, коротко и дружелюбно.
`;

    const chatText = `
${systemPrompt}

История диалога:
${history.map((m) => `${m.role}: ${m.content}`).join('\n')}

Пользователь: ${String(message).trim()}
TravelPay AI:
`;

    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      contents: chatText,
    });

    return res.json({
      reply: result.text || 'Не удалось получить ответ.',
    });
  } catch (error) {
    console.error('AI error:', error);
    return res.status(500).json({
      reply: 'Сейчас ассистент временно недоступен, попробуйте позже.',
    });
  }
});

module.exports = router;
