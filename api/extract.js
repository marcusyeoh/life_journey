const https = require('https');

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-API-Key, X-AI-Provider');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    return;
  }

  try {
    const clientPayload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    
    let apiKey = req.headers['x-api-key'];
    let provider = req.headers['x-ai-provider'] || 'gemini';

    // Fallback to environment variables if header key is missing or empty
    if (!apiKey || apiKey.trim() === '') {
      if (provider === 'openai' && process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
      } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY;
      } else if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
        provider = 'openai';
      } else if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY;
        provider = 'gemini';
      }
    }

    if (!apiKey || apiKey.trim() === '') {
      res.status(400).json({ error: 'Missing API Key. Please supply a key in the settings panel or configure it in Vercel environment variables.' });
      return;
    }

    // Clean and sanitize API key to remove trailing spaces, newlines, or carriage returns
    apiKey = apiKey.trim().replace(/[\r\n]+/g, '');

    if (provider === 'openai') {
      await proxyOpenAI(apiKey, clientPayload, res);
    } else if (provider === 'gemini') {
      await proxyGemini(apiKey, clientPayload, res);
    } else {
      res.status(400).json({ error: `Unsupported AI Provider: ${provider}` });
    }
  } catch (err) {
    res.status(400).json({ error: `Invalid payload or processing error: ${err.message}` });
  }
};

function proxyOpenAI(apiKey, clientPayload, clientRes) {
  return new Promise((resolve, reject) => {
    try {
      let model = clientPayload.model || 'gpt-4o';
      if (!model.startsWith('gpt-')) {
        model = 'gpt-4o';
      }

      const openaiPayload = JSON.stringify({
        model: model,
        response_format: { type: "json_object" },
        messages: clientPayload.messages,
        max_tokens: clientPayload.max_tokens || 2000
      });

      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(openaiPayload)
        }
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          clientRes.status(res.statusCode).send(data);
          resolve();
        });
      });

      req.on('error', err => {
        console.error("OpenAI Server Proxy Error:", err);
        clientRes.status(500).json({ error: `OpenAI proxy error: ${err.message}` });
        resolve();
      });

      req.write(openaiPayload);
      req.end();
    } catch (err) {
      clientRes.status(500).json({ error: `OpenAI payload assembly failed: ${err.message}` });
      resolve();
    }
  });
}

function proxyGemini(apiKey, clientPayload, clientRes) {
  return new Promise((resolve, reject) => {
    try {
      let model = clientPayload.model || 'gemini-2.5-flash';
      if (!model.startsWith('gemini-')) {
        model = 'gemini-2.5-flash';
      }

      // Extract prompt and images from OpenAI-style payload
      let promptText = '';
      const imagesParts = [];

      const messages = clientPayload.messages || [];
      messages.forEach(msg => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(part => {
            if (part.type === 'text') {
              promptText += part.text + '\n';
            } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
              const urlStr = part.image_url.url;
              if (urlStr.startsWith('data:')) {
                const match = urlStr.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  imagesParts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2]
                    }
                  });
                }
              }
            }
          });
        } else if (typeof msg.content === 'string') {
          promptText += msg.content + '\n';
        }
      });

      const geminiPayload = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText.trim() },
              ...imagesParts
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: "OBJECT",
            properties: {
              chain_of_thought: { type: "STRING" },
              layout_type: { type: "STRING" },
              first_row_ymin: { type: "INTEGER" },
              players: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    transcribed_subtext: { type: "STRING" },
                    dupr: { type: "NUMBER" },
                    image_index: { type: "INTEGER" },
                    grid_row: { type: "INTEGER" },
                    grid_column: { type: "INTEGER" },
                    avatar_box: {
                      type: "ARRAY",
                      items: { type: "NUMBER" }
                    }
                  },
                  required: ["name", "transcribed_subtext", "dupr", "image_index", "grid_row", "grid_column", "avatar_box"]
                }
              }
            },
            required: ["chain_of_thought", "layout_type", "first_row_ymin", "players"]
          }
        }
      });

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(geminiPayload)
        }
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            clientRes.status(res.statusCode).send(data);
            resolve();
            return;
          }

          try {
            const geminiResult = JSON.parse(data);
            let innerJson = '{}';

            if (geminiResult.candidates && geminiResult.candidates[0] &&
                geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
                geminiResult.candidates[0].content.parts[0]) {
              innerJson = geminiResult.candidates[0].content.parts[0].text;
            }

            const formattedOpenAIResponse = {
              choices: [
                {
                  message: {
                    content: innerJson
                  }
                }
              ]
            };

            clientRes.status(200).json(formattedOpenAIResponse);
            resolve();
          } catch (e) {
            clientRes.status(500).json({ error: `Failed to format Gemini response: ${e.message}`, raw: data });
            resolve();
          }
        });
      });

      req.on('error', err => {
        console.error("Gemini Server Proxy Error:", err);
        clientRes.status(500).json({ error: `Gemini proxy error: ${err.message}` });
        resolve();
      });

      req.write(geminiPayload);
      req.end();

    } catch (err) {
      clientRes.status(500).json({ error: `Gemini payload assembly failed: ${err.message}` });
      resolve();
    }
  });
}
