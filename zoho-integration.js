require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- ENVIRONMENT VARIABLES EXTRACTION ---
const {
    ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN,
    ZOHO_INITIAL_ACCESS_TOKEN,
    VOX_ACCESS_TOKEN,
    VOX_ACCOUNT_NAME,
    VOX_API_HOST,
    PORT
} = process.env;

// --- CONFIGURATION DEBUG BLOCK ---
console.log("\n=== ⚙️ CONFIGURATION VALIDATION ===");
const configStatus = {
    ZOHO_CLIENT_ID: ZOHO_CLIENT_ID || "MISSING ❌",
    ZOHO_SECRET: ZOHO_CLIENT_SECRET ? "OK ✅" : "MISSING ❌",
    ZOHO_REFRESH: ZOHO_REFRESH_TOKEN ? "OK ✅" : "MISSING ❌",
    VOX_TOKEN: VOX_ACCESS_TOKEN ? "OK ✅" : "MISSING ❌",
    VOX_HOST: VOX_API_HOST || "MISSING ❌",
    VOX_DOMAIN: VOX_ACCOUNT_NAME || "MISSING ❌",
    PORT: PORT || "3000 (Default)"
};
console.table(configStatus);
if (!VOX_API_HOST) console.error("🚨 ERROR: VOX_API_HOST not detected. Check .env file name.");
console.log("======================================\n");

let zohoAccessToken = ZOHO_INITIAL_ACCESS_TOKEN; // Global variable for Zoho OAuth token
const userEmailCache = {}; // Cache for Voximplant user emails
const zohoIdCache = {}; // Cache for Zoho User IDs
const campaignNameCache = {}; // Cache for Voximplant campaign titles

// --- CACHÉ PARA COMBINAR CALLS ---
const callSessionCache = {}; 
// Caché para cuando call_finalized llega antes que new_calls
const finalizedWaitingCache = {};

// 1. Standardizes phone numbers to 12 digits (57XXXXXXXXXX)
function normalizePhone(rawPhone) {
    if (!rawPhone) return null;
    let cleaned = rawPhone.toString().replace(/\D/g, ''); 
    if (cleaned.length > 12 && cleaned.startsWith('57')) {
        cleaned = cleaned.substring(0, 12);
    } else if (cleaned.length === 10) {
        cleaned = `57${cleaned}`;
    }
    return cleaned;
}

// 2. Returns current timestamp in Zoho format (Colombia time)
function getZohoDateTime() {
    const now = new Date();
    now.setHours(now.getHours() - 5); 
    return now.toISOString().split('.')[0];
}

// 3. Requests a new Zoho access token using the refresh token
async function refreshZohoToken() {
    try {
        const url = `https://accounts.zoho.com/oauth/v2/token?refresh_token=${ZOHO_REFRESH_TOKEN}&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;
        const response = await axios.post(url);
        if (response.data && response.data.access_token) {
            zohoAccessToken = response.data.access_token;
            console.log("✅ [ZOHO] Token refreshed successfully.");
            return zohoAccessToken;
        }
    } catch (e) {
        console.error("❌ [ZOHO] Refresh error:", e.response ? e.response.data : e.message);
        return null;
    }
}

// 4. Retrieves agent email from Voximplant using user_id
async function getVoxUserEmail(userId) {
    if (!userId) return null;
    if (userEmailCache[userId]) return userEmailCache[userId];

    console.log(`[VOX] Querying searchUsers for ID: ${userId}...`);
    try {
        const url = `https://${VOX_API_HOST}/api/v3/user/searchUsers?domain=${VOX_ACCOUNT_NAME}`;
        const params = new URLSearchParams();
        params.append('access_token', VOX_ACCESS_TOKEN);
        params.append('id', `[${userId}]`);

        const response = await axios.post(url, params);

        if (response.data && response.data.result && response.data.result[0]) {
            const email = response.data.result[0].email;
            userEmailCache[userId] = email;
            console.log(`[VOX] ✅ Email found: ${email}`);
            return email;
        }
    } catch (e) {
        console.error(`[VOX] ❌ searchUsers error: ${e.message}`);
    }
    return null;
}

// 5. Retrieves campaign name from Voximplant Kit API
async function getVoxCampaignName(campaignId) {
    if (!campaignId) return "Manual Call";
    if (campaignNameCache[campaignId]) return campaignNameCache[campaignId];

    console.log(`[VOX] Querying searchCampaigns for ID: ${campaignId}...`);
    try {
        const url = `https://${VOX_API_HOST}/api/v3/agentCampaigns/searchCampaigns?domain=${VOX_ACCOUNT_NAME}`;
        const params = new URLSearchParams();
        params.append('access_token', VOX_ACCESS_TOKEN);
        params.append('id', campaignId);

        const response = await axios.post(url, params);

        if (response.data?.result && response.data.result[0]?.title) {
            const title = response.data.result[0].title;
            campaignNameCache[campaignId] = title;
            console.log(`[VOX] ✅ Campaign title found: ${title}`);
            return title;
        }
    } catch (e) {
        console.error(`[VOX] ❌ searchCampaigns error: ${e.message}`);
    }
    return "Voximplant Campaign";
}

// 6. Gets Zoho User ID by email with retry logic
async function getZohoUserId(email, isRetry = false) {
    if (!email) return null;
    if (zohoIdCache[email]) return zohoIdCache[email];

    console.log(`[ZOHO] Searching ID for: ${email}...`);
    try {
        const response = await axios.get(`https://www.zohoapis.com/crm/v2/users/search?email=${email}`, {
            headers: { 'Authorization': `Zoho-oauthtoken ${zohoAccessToken}` }
        });
        
        if (response.data && response.data.users) {
            const id = response.data.users[0].id;
            zohoIdCache[email] = id;
            console.log(`[ZOHO] ✅ ID Found: ${id}`);
            return id;
        }
        return null;
    } catch (e) {
        if (e.response?.status === 401 && !isRetry) {
            console.log("🔄 [ZOHO] 401 detected. Refreshing token and waiting 2s...");
            const newToken = await refreshZohoToken();
            if (newToken) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return getZohoUserId(email, true); 
            }
        }
        console.error(`[ZOHO] ❌ User search error: ${e.message}`);
        return null;
    }
}

// 7. Creates a Zoho Note linked to the call record (Fixed 401 Retry)
async function createZohoNote(callId, content, isRetry = false) {
    if (!content || !callId) return;
    const noteData = {
        "data": [{
            "Note_Title": "Notas de Voximplant",
            "Note_Content": content,
            "Parent_Id": callId,
            "$se_module": "Calls"
        }]
    };
    try {
        await axios.post('https://www.zohoapis.com/crm/v2/Notes', noteData, {
            headers: { 'Authorization': `Zoho-oauthtoken ${zohoAccessToken}` }
        });
        console.log("📝 Nota inyectada en Zoho.");
    } catch (e) {
        if (e.response?.status === 401 && !isRetry) {
            console.log("🔄 [ZOHO NOTE] 401 detected. Refreshing token and retrying...");
            await refreshZohoToken();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return createZohoNote(callId, content, true);
        } else {
            console.error("❌ Error definitivo en nota:", e.message);
        }
    }
}

// --- FUNCIÓN INTERNA DE INYECCIÓN ---
async function processZohoInjection(callRoot, cachedData = {}) {
    const sessionId = callRoot.session_id;
    const agentEmail = await getVoxUserEmail(callRoot.user_id);
    const zohoOwnerId = await getZohoUserId(agentEmail);
    
    let subjectName = "Manual Call";
    if (callRoot.agent_campaign?.title) {
        subjectName = callRoot.agent_campaign.title;
    } else if (callRoot.agent_campaign_id || callRoot.campaign_id) {
        subjectName = await getVoxCampaignName(callRoot.agent_campaign_id || callRoot.campaign_id);
    }

    const tagsString = (callRoot.tags && callRoot.tags.length > 0) 
        ? callRoot.tags.map(t => t.tag_name).join(', ') 
        : 'No Tags';
        
    const topicsString = (callRoot.topics && callRoot.topics.length > 0) 
        ? callRoot.topics.map(t => t.topic_name).join(', ') 
        : 'No Topics';

    // Priorizamos el wrap_up_code si viene en callRoot (finalize) o en cachedData (new_calls)
    const wrapUpText = callRoot.wrap_up_code?.title || cachedData.wrap_up_code?.title || callRoot.completion_code || 'Completed';
    
    const recordingUrl = callRoot.record_url || cachedData.record_url || "No Recording";

    let detailedInfo = { duration: callRoot.duration, incoming: callRoot.is_incoming, remote_number: callRoot.phone_b };
    const segmentsRaw = callRoot.call_calls || cachedData.call_calls;
    if (segmentsRaw) {
        try {
            const allSegments = JSON.parse(segmentsRaw);
            detailedInfo = allSegments.find(c => c.remote_number_type === 'pstn') || detailedInfo;
        } catch(e) { console.log("Error parsing segments"); }
    }

    const normalizedNumber = normalizePhone(detailedInfo.remote_number || callRoot.phone_b);

    let entityId = null;
    let entityModule = 'Contacts';
    
    try {
        let search = await axios.get(`https://www.zohoapis.com/crm/v2/Contacts/search?phone=${normalizedNumber}`, {
            headers: { 'Authorization': `Zoho-oauthtoken ${zohoAccessToken}` }
        });
        if (search.data?.data) {
            entityId = search.data.data[0].id;
        } else {
            let leadSearch = await axios.get(`https://www.zohoapis.com/crm/v2/Leads/search?phone=${normalizedNumber}`, {
                headers: { 'Authorization': `Zoho-oauthtoken ${zohoAccessToken}` }
            });
            if (leadSearch.data?.data) {
                entityId = leadSearch.data.data[0].id;
                entityModule = 'Leads';
            }
        }
    } catch (err) {
        if (err.response?.status === 401) await refreshZohoToken();
    }

    const callData = {
        "data": [{
            "Who_Id": entityId,
            "$se_module": entityModule,
            "Owner": zohoOwnerId, 
            "Subject": subjectName, 
            "Call_Start_Time": getZohoDateTime(),
            "Call_Duration": (callRoot.duration || 0).toString(),
            "Call_Type": callRoot.is_incoming ? "Inbound" : "Outbound",
            "Call_Result": wrapUpText, 
            "Description": `Agent: ${agentEmail} | Topics: ${topicsString} | Tags: ${tagsString} | Recording: ${recordingUrl} | Session ID: ${sessionId}`
        }]
    };

    const response = await axios.post('https://www.zohoapis.com/crm/v2/Calls', callData, {
        headers: { 'Authorization': `Zoho-oauthtoken ${zohoAccessToken}` }
    });

    if (response.data?.data?.[0]?.status === 'success') {
        const createdCallId = response.data.data[0].details.id;
        console.log(`✨ Injection Status: success (ID: ${createdCallId})`);

        if (callRoot.comments && callRoot.comments.length > 0) {
            const commentText = callRoot.comments.map(c => c.comment).join(' | ');
            await createZohoNote(createdCallId, commentText);
        }
        return true;
    }
    return false;
}

// --- MAIN WEBHOOK ENDPOINT ---
app.post('/', async (req, res) => {
    console.log("\n--- 📝 INCOMING REQUEST PAYLOAD ---");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("-----------------------------------\n");

    const callbackWrapper = req.body.callbacks?.[0];
    if (!callbackWrapper) return res.sendStatus(200);

    const type = callbackWrapper.type;

    // --- CAPTURA DE DATOS EN NEW_CALLS ---
    if (type === 'new_calls') {
        const callRoot = callbackWrapper.new_calls?.calls?.[0];
        if (callRoot) {
            const sessionId = callRoot.session_id;
            const isCampaign = callRoot.agent_campaign_id || callRoot.campaign_id;

            if (!isCampaign) {
                console.log(`[MANUAL] Detectada llamada manual (Session: ${sessionId}). Inyectando inmediatamente.`);
                await processZohoInjection(callRoot);
            } else {
                // AQUÍ ESTABA EL ERROR: Revisar si ya hay un finalized esperando ANTES de guardar en caché
                if (finalizedWaitingCache[sessionId]) {
                    console.log(`[SYNC] [!] Encontrada sesión finalized en espera para ${sessionId}. Procesando ahora.`);
                    await processZohoInjection(finalizedWaitingCache[sessionId], {
                        record_url: callRoot.record_url,
                        call_calls: callRoot.call_calls,
                        wrap_up_code: callRoot.wrap_up_code // Por si viene en new_calls
                    });
                    delete finalizedWaitingCache[sessionId];
                } else {
                    console.log(`[CAMPAIGN] Guardando new_calls en caché para session: ${sessionId}`);
                    callSessionCache[sessionId] = {
                        record_url: callRoot.record_url,
                        call_calls: callRoot.call_calls,
                        wrap_up_code: callRoot.wrap_up_code
                    };
                }
            }
        }
        return res.sendStatus(200); 
    }

    // --- PROCESAMIENTO Y DISPARO EN CALL_FINALIZED ---
    if (type === 'call_finalized') {
        console.log("--- 🕵️ DEBUG: FULL CALL_FINALIZED PAYLOAD ---");
        console.log(JSON.stringify(callbackWrapper, null, 2));
        console.log("----------------------------------------------");

        try {
            const callRoot = callbackWrapper.call_finalized?.call_finalized;
            if (!callRoot) return res.sendStatus(200);

            const sessionId = callRoot.session_id;
            const cachedData = callSessionCache[sessionId];

            if (cachedData) {
                console.log(`[FINALIZED] Procesando sesión de campaña: ${sessionId}`);
                const success = await processZohoInjection(callRoot, cachedData);
                if (success) {
                    delete callSessionCache[sessionId];
                }
            } else {
                // Carrera de eventos: finalized antes que new_calls
                console.log(`[WAITING] finalized llegó antes que new_calls para session: ${sessionId}. Guardando en espera.`);
                finalizedWaitingCache[sessionId] = callRoot;
                
                // Limpieza de seguridad tras 1 minuto
                setTimeout(() => {
                    if (finalizedWaitingCache[sessionId]) delete finalizedWaitingCache[sessionId];
                }, 60000);
            }

        } catch (error) {
            console.error('❌ Error en Call Finalized:', error.message);
        }
    }

    res.sendStatus(200);
});

const serverPort = PORT || 3000;
app.listen(serverPort, () => console.log(`🚀 Server running on port ${serverPort}`));