const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-livechat-signature', 'X-LiveChat-Signature']
}));

app.use(bodyParser.json());

const BOT_API_URL = 'https://api.botatwork.com/trigger-task/42eaa2c8-e8aa-43ad-b9b5-944981bce2a2';
const BOT_API_KEYS = [
    'bf2e2d7e409bc0d7545e14ae15a773a3',
    'ead5bd1e5c1d5caaabab4a659012fe4e'
];
const WEBHOOK_SECRET = 'fSzbKfowu5bfNBb6rGRFCjoK6DDDZtS3';
const PORT = process.env.PORT || 3000;

let chatMessages = new Map();
let processedThreadEvents = new Map();
const conversationContexts = new Map();
const processingLocks = new Map();

function verifySignature(req) {
    const signature = req.get('X-LiveChat-Signature') || req.get('x-livechat-signature');
    if (!signature) {
        console.log('No signature header found');
        return true;
    }
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(JSON.stringify(req.body));
    const digest = hmac.digest('hex');
    return signature === digest;
}

app.post('/livechat/webhook', (req, res) => {
    res.status(200).send('OK');

    (async () => {
        let messageText = null;
        let chatId = null;
        let threadId = null;
        let eventId = null;

        // Detect webhook type test
	if (req.body.action === "incoming_event") {
	    messageText = req.body.payload?.event?.text;
	    chatId = req.body.payload?.chat_id;
	    threadId = req.body.payload?.thread_id;
	    eventId = req.body.payload?.event?.id;

	} else if (req.body.action === "incoming_chat") {
	    const events = req.body.payload?.chat?.thread?.events || [];
	    const customerIds = (req.body.payload?.chat?.users || [])
	        .filter(u => u.type === "customer")
	        .map(u => u.id);

	    const firstCustomerMsg = events.find(ev =>
	        ev.type === "message" &&
	        ev.text &&
	        customerIds.includes(ev.author_id)
	    );

	    messageText = firstCustomerMsg?.text || null;
	    chatId = req.body.payload?.chat?.id;
	    threadId = req.body.payload?.chat?.thread?.id;
	    eventId = firstCustomerMsg?.id || null;
	}


        const agentId = req.body.additional_data?.chat_presence_user_ids?.find(id => id.includes('@')) || null;

        if (!messageText || !chatId || !threadId || !eventId) {
            console.log('Missing required data');
            return;
        }

        console.log('-----------------------------');
        console.log('Webhook Type:', req.body.action);
        console.log('Chat ID:', chatId);
        console.log('Thread ID:', threadId);
        console.log('Agent ID:', agentId);
        console.log('Visitor Message:', messageText);

        const eventKey = `${threadId}_${eventId}`;
        if (!processedThreadEvents.has(chatId)) {
            processedThreadEvents.set(chatId, new Set());
        }

        if (processedThreadEvents.get(chatId).has(eventKey)) {
            console.log('Duplicate message skipped');
            return;
        }

        const prev = processingLocks.get(chatId) || Promise.resolve();
        let release;
        const lock = new Promise(resolve => (release = resolve));
        processingLocks.set(chatId, prev.then(() => lock));

        try {
            await prev;

            processedThreadEvents.get(chatId).add(eventKey);

            if (!chatMessages.has(chatId)) {
                chatMessages.set(chatId, {
                    messages: [],
                    agentIds: new Set()
                });
            }

            if (agentId) {
                chatMessages.get(chatId).agentIds.add(agentId);
            }

            if (!conversationContexts.has(chatId)) {
                conversationContexts.set(chatId, {
                    messages: [],
                    lastUpdate: Date.now()
                });
            }

            const visitorMessageData = {
                visitorMessage: messageText,
                botResponse: null,
                timestamp: new Date().toISOString(),
                threadId: threadId
            };
            chatMessages.get(chatId).messages.push(visitorMessageData);

            const context = conversationContexts.get(chatId);
            context.messages.push(`Visitor: ${messageText}`);
            context.lastUpdate = Date.now();

            const fullContext = context.messages.join('\n');

            const botPayload = {
                data: {
                    payload: {
                        override_model: 'sonar',
                        clientQuestion: fullContext
                    }
                },
                should_stream: false
            };

            let botAnswer = "☹️ No answer from bot";
            let retryCount = 0;
            const maxRetries = 3;
            let keyIndex = 0;

            while (keyIndex < BOT_API_KEYS.length) {
                let success = false;
                while (retryCount < maxRetries) {
                    try {
                        const botResponse = await axios.post(BOT_API_URL, botPayload, {
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': BOT_API_KEYS[keyIndex]
                            }
                        });

                        botAnswer = botResponse.data?.data?.content || botResponse.data?.message || "☹️ No answer from bot";
                        success = true;
                        break;
                    } catch (err) {
                        retryCount++;
                        const status = err.response?.status;
                        const statusText = err.response?.statusText;

                        if (retryCount === maxRetries) {
                            if (status) {
                                botAnswer = `☹️ No answer from bot. Status: ${status} ${statusText || ''}`.trim();
                            } else {
                                botAnswer = `☹️ No answer from bot.`;
                            }
                        }

                        console.error(`Bot API call failed (attempt ${retryCount}, key ${keyIndex + 1}):`, err.message);
                        if (retryCount < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }

                if (success) break;
                keyIndex++;
                retryCount = 0;
            }

            context.messages.push(`Bot: ${botAnswer}`);

            const messageData = {
                visitorMessage: messageText,
                botResponse: botAnswer,
                timestamp: new Date().toISOString(),
                threadId: threadId
            };

            chatMessages.get(chatId).messages.push(messageData);

            console.log('Bot Response:', botAnswer);
        } catch (error) {
            console.error('Error processing message:', error);
        } finally {
            release();
        }
    })();
});

app.get('/livechat/chats/:agentId', (req, res) => {
    const requestedAgentId = req.params.agentId;
    const agentChats = [];

    for (const [chatId, chatData] of chatMessages.entries()) {
        if (!chatData.agentIds?.has(requestedAgentId)) continue;

        // Group messages by threadId
        const threads = {};
        for (const msg of chatData.messages) {
            if (!msg.threadId) continue;
            if (!threads[msg.threadId]) threads[msg.threadId] = [];
            threads[msg.threadId].push(msg);
        }

        // For each thread, push a separate object
        for (const [threadId, messages] of Object.entries(threads)) {
            agentChats.push({
                chatId,
                threadId,
                messages
            });
        }
    }

    res.json(agentChats);
});

app.get('/livechat/chat/:chatId', (req, res) => {
    const chatId = req.params.chatId;
    const chatData = chatMessages.get(chatId);
    res.json(chatData ? chatData.messages : []);
});

setInterval(() => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    conversationContexts.forEach((context, chatId) => {
        if (context.lastUpdate < oneHourAgo) {
            conversationContexts.delete(chatId);
            chatMessages.delete(chatId);
            processedThreadEvents.delete(chatId);
            processingLocks.delete(chatId);
            console.log(`Cleaned up conversation for chat ID: ${chatId}`);
        }
    });
}, 60 * 60 * 1000);

app.get("/test", (req, res) => {
    res.send("This is a test get API");
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
