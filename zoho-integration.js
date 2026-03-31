const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const CLIENT_ID = '1000.CU8WFKLH59VCUHZADOGPYR8M2VXLED';
const CLIENT_SECRET = '1000.078858639c2b17ae9997569b859dda38845060b1ec';
const REFRESH_TOKEN = '1000.358f30f83593f8d8b9dda586fd41d030.60a3908a125c78cc6cfb73c364d5e3d0';
let accessToken = '1000.95a23164d70023f6de77a5b4692190d7.f679e10b71d68a7c6b2454a2954dd786';

function normalizePhone(rawPhone) {
    if (!rawPhone) return null;
    let cleaned = rawPhone.toString().replace(/\D/g, ''); 
    if (cleaned.length === 10) return `57${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('57')) return cleaned;
    return cleaned;
}

function getZohoDateTime() {
    const now = new Date();
    // Restamos 5 horas manualmente para pasar de UTC a hora Colombia
    now.setHours(now.getHours() - 5); 
    
    // Formato: YYYY-MM-DDTHH:mm:ss
    const localISO = now.toISOString().split('.')[0];
    
    // Le enviamos a Zoho la hora ya restada sin el offset para que no se confunda
    return localISO; 
}

async function refreshZohoToken() {
    console.log("Ingresa al refreshZohoToken")
    try {
        const url = `https://accounts.zoho.com/oauth/v2/token?refresh_token=${REFRESH_TOKEN}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=refresh_token`;
        const response = await axios.post(url);
        if (response.data.access_token) {
            accessToken = response.data.access_token;
            console.log("✅ Token de Zoho refrescado con éxito.");
            return accessToken;
        }
    } catch (error) {
        console.error("❌ Error crítico al refrescar token:", error.response ? error.response.data : error.message);
    }
}

app.post('/', async (req, res) => {
    try {
        const callback = req.body.callbacks && req.body.callbacks[0];
        const callRoot = callback?.new_calls?.calls?.[0];

        if (!callRoot) {
            console.log("⚠️ Webhook recibido pero sin datos de llamada compatibles.");
            return res.sendStatus(200);
        }

        const allSegments = JSON.parse(callRoot.call_calls);
        const detailedInfo = allSegments.find(c => c.remote_number_type === 'pstn') || allSegments[0];

        const rawNumber = detailedInfo.remote_number || callRoot.phone_b;
        const normalizedNumber = normalizePhone(rawNumber);
        
        console.log(`🔍 Buscando en Zoho: [${normalizedNumber}]`);

        let entityId = null;
        let entityModule = 'Contacts';
        let config = { headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` } };

        try {
            let search = await axios.get(`https://www.zohoapis.com/crm/v2/Contacts/search?phone=${normalizedNumber}`, config);
            
            if (search.data && search.data.data) {
                entityId = search.data.data[0].id;
                console.log(`🎯 Contacto encontrado: ${entityId}`);
            } else {
                let leadSearch = await axios.get(`https://www.zohoapis.com/crm/v2/Leads/search?phone=${normalizedNumber}`, config);
                if (leadSearch.data && leadSearch.data.data) {
                    entityId = leadSearch.data.data[0].id;
                    entityModule = 'Leads';
                    console.log(`🎯 Lead encontrado: ${entityId}`);
                } else {
                    console.log(`⚠️ El número ${normalizedNumber} no existe en Zoho.`);
                }
            }
        } catch (err) {
            if (err.response && err.response.status === 401) {
                console.log("🔄 Token expirado. Intentando refrescar...");
                const newToken = await refreshZohoToken();
                config = { headers: { 'Authorization': `Zoho-oauthtoken ${newToken}` } };
            }
        }

        const callData = {
            "data": [{
                "Who_Id": entityId,
                "$se_module": entityModule,
                "Subject": callRoot.agent_campaign_id ? "Campaña Voximplant" : "Llamada Manual",
                "Call_Start_Time": getZohoDateTime(),
                "Call_Duration": (detailedInfo.duration || 0).toString(),
                "Call_Type": detailedInfo.incoming ? "Inbound" : "Outbound",
                "Call_Result": "Completada",
                "Description": `Sesión: ${callRoot.session_id} | Costo: ${detailedInfo.cost} | ID Vox: ${detailedInfo.call_id}`
            }]
        };

        const response = await axios.post('https://www.zohoapis.com/crm/v2/Calls', callData, {
            headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
        });

        if (response.data.data[0].status === 'success') {
            console.log(`✨ ¡Éxito! Llamada registrada para el ID: ${entityId || 'Huérfana'}`);
        } else {
            console.log(`❌ Error de Zoho al inyectar:`, JSON.stringify(response.data.data[0].details));
        }

        res.sendStatus(200);

    } catch (error) {
        console.error('❌ Error general en el proceso:', error.message);
        res.sendStatus(200); 
    }
});

app.listen(3000, () => {
    console.log("🚀 Servidor de Integración Zoho-Voximplant");
    console.log("📍 Escuchando en el puerto 3000...");
});
