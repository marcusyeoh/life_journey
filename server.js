const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// Zero-dependency .env parser
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      // Ignore comments and empty lines
      if (!line || line.trim().startsWith('#')) return;
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        // Strip quotes if present
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        process.env[key] = value.trim();
      }
    });
    console.log("🔒 Loaded environment credentials from .env file successfully.");
  }
} catch (err) {
  console.warn("⚠️ Failed to read .env file:", err.message);
}

const server = http.createServer((req, res) => {
  // Set CORS headers for all local requests just in case
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-AI-Provider');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Handle the proxy extraction endpoint
  if (pathname === '/api/extract' && req.method === 'POST') {
    handleAIProxy(req, res);
    return;
  }

  // Handle static file serving
  handleStaticFiles(pathname, res);
});

function handleStaticFiles(pathname, res) {
  // Default to index.html if pointing to root or admin root
  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (filePath === '/admin' || filePath === '/admin/') {
    filePath = '/admin/index.html';
  }

  const absolutePath = path.join(__dirname, filePath);

  // Security check: ensure file path is inside workspace directory
  if (!absolutePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(absolutePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 404 Fallback
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(absolutePath);
    stream.pipe(res);
  });
}

function handleAIProxy(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      let apiKey = req.headers['x-api-key'];
      let provider = req.headers['x-ai-provider'] || 'gemini';

      // Fallback to environment variables if header key is missing or empty
      if (!apiKey || apiKey.trim() === '') {
        if (provider === 'openai' && process.env.OPENAI_API_KEY) {
          apiKey = process.env.OPENAI_API_KEY;
        } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
          apiKey = process.env.GEMINI_API_KEY;
        } else if (process.env.OPENAI_API_KEY) {
          // If a key is present and is OpenAI, default provider to openai
          apiKey = process.env.OPENAI_API_KEY;
          provider = 'openai';
        } else if (process.env.GEMINI_API_KEY) {
          apiKey = process.env.GEMINI_API_KEY;
          provider = 'gemini';
        }
      }

      if (!apiKey || apiKey.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing API Key. Please supply a key in the settings panel or write it into a local .env file.' }));
        return;
      }

      // Clean and sanitize API key to remove trailing spaces, newlines, or carriage returns
      apiKey = apiKey.trim().replace(/[\r\n]+/g, '');

      if (provider === 'openai') {
        proxyOpenAI(apiKey, payload, res);
      } else if (provider === 'gemini') {
        proxyGemini(apiKey, payload, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unsupported AI Provider: ${provider}` }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid JSON payload: ${err.message}` }));
    }
  });
}

function proxyOpenAI(apiKey, clientPayload, clientRes) {
  let model = clientPayload.model || 'gpt-4o';
  if (!model.startsWith('gpt-')) {
    model = 'gpt-4o'; // Force fallback to gpt-4o if a Gemini model is passed to OpenAI
  }

  // Reconstruct standard OpenAI request payload
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
      clientRes.writeHead(res.statusCode, { 'Content-Type': 'application/json' });
      clientRes.end(data);
    });
  });

  req.on('error', err => {
    console.error("OpenAI Server Proxy Error:", err);
    clientRes.writeHead(500, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `OpenAI proxy error: ${err.message}` }));
  });

  req.write(openaiPayload);
  req.end();
}

function proxyGemini(apiKey, clientPayload, clientRes) {
  try {
    let model = clientPayload.model || 'gemini-2.5-flash';
    if (!model.startsWith('gemini-')) {
      model = 'gemini-2.5-flash'; // Force fallback to gemini-2.5-flash if an OpenAI model is passed to Gemini
    }

    // 1. Extract prompt and images from OpenAI-style payload
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
              // Extract MIME type and Base64 data: e.g. "data:image/jpeg;base64,abc..."
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

    // 2. Build standard Gemini contents payload
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
            players: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  transcribed_subtext: { type: "STRING" },
                  dupr: { type: "NUMBER" }
                },
                required: ["name", "transcribed_subtext", "dupr"]
              }
            }
          },
          required: ["chain_of_thought", "players"]
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
          clientRes.writeHead(res.statusCode, { 'Content-Type': 'application/json' });
          clientRes.end(data);
          return;
        }

        try {
          const geminiResult = JSON.parse(data);
          let innerJson = '{}';

          // Extract content from Gemini response candidates
          if (geminiResult.candidates && geminiResult.candidates[0] &&
              geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
              geminiResult.candidates[0].content.parts[0]) {
            innerJson = geminiResult.candidates[0].content.parts[0].text;
          }

          // Re-map back to standard OpenAI Chat Completion response format
          const formattedOpenAIResponse = {
            choices: [
              {
                message: {
                  content: innerJson
                }
              }
            ]
          };

          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(formattedOpenAIResponse));
        } catch (e) {
          clientRes.writeHead(500, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: `Failed to format Gemini response: ${e.message}`, raw: data }));
        }
      });
    });

    req.on('error', err => {
      console.error("Gemini Server Proxy Error:", err);
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: `Gemini proxy error: ${err.message}` }));
    });

    req.write(geminiPayload);
    req.end();

  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `Gemini payload assembly failed: ${err.message}` }));
  }
}

server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 PickleMix Secure Proxy Server started!`);
  console.log(`👉 Access URL: http://localhost:${PORT}`);
  console.log(`🔒 Secure local API proxy listening at /api/extract`);
  console.log(`==================================================`);
});
