'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { io } = require('../dashboard/node_modules/socket.io-client');
const { StudyBot, INTRO, SYSTEM_PROMPT, storedIncoming } = require('./estudo-ai-core.cjs');
const MODEL = 'gemini-3.5-flash-lite';

async function startStudyServer({ createKey, updateKey, startSession, checkNumber, getQr, shutdown }) {
  if (process.env.BIND_HOST !== '127.0.0.1' || String(process.env.PORT || 2785) !== '2785') {
    throw new Error('O laboratório exige API em 127.0.0.1:2785.');
  }
  const config = JSON.parse(fs.readFileSync(path.resolve('data/estudo-config.json'), 'utf8'));
  if (config.recipients?.length !== 1 || new Set(config.recipients).size !== 1 ||
      config.recipients.some(p => !/^55\d{11}$/.test(p))) throw new Error('Configure somente o contato autorizado.');
  const sessionDb = new Database(path.resolve('data/openwa.sqlite'), { readonly: true });
  const session = sessionDb.prepare('SELECT id,status FROM sessions WHERE name = ?').get(config.sessionName);
  sessionDb.close();
  if (!session) throw new Error('Sessão de estudo não encontrada.');
  const db = new Database(path.resolve('data/estudo-ai.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (phone TEXT PRIMARY KEY, claim TEXT, invited INTEGER DEFAULT 0,
    invitedAt INTEGER, consented INTEGER DEFAULT 0, stopped INTEGER DEFAULT 0, replies INTEGER DEFAULT 0, lastReplyAt INTEGER);
    CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, phone TEXT);`);
  const store = {
    contact: p => db.prepare('SELECT * FROM contacts WHERE phone=?').get(p),
    claimInvite: (p, k, t) => db.prepare('INSERT OR IGNORE INTO contacts(phone,claim,invitedAt) VALUES(?,?,?)').run(p,k,t).changes === 1,
    inviteSent: p => db.prepare('UPDATE contacts SET invited=1 WHERE phone=?').run(p),
    claimMessage: (id,p) => db.prepare('INSERT OR IGNORE INTO seen(id,phone) VALUES(?,?)').run(id,p).changes === 1,
    seen: id => !!db.prepare('SELECT 1 FROM seen WHERE id=?').get(id),
    stop: p => db.prepare('UPDATE contacts SET stopped=1 WHERE phone=?').run(p),
    beginReply: (p,t) => db.prepare('UPDATE contacts SET consented=1,replies=replies+1,lastReplyAt=? WHERE phone=?').run(t,p),
  };
  const csrf = crypto.randomBytes(24).toString('hex');
  let geminiKey = '', operatorKey = '', keyId = '', socket, bot, configuring = false, sending = false;
  let providerReady = false, subscribed = false, sessionReady = false;
  let notice = 'Insira a chave Gemini para validar. Nenhuma mensagem foi enviada.';
  const chatIds = new Map();
  const lidCache = new Map();
  const diagnostics = {events:0,polls:0,recovered:0,lastEventAt:null,lastPollRows:0};
  let polling=false;

  async function handleMessage(m, verifiedPhone) {
    if (!m || m.fromMe || m.isGroup || m.type!=='text' || !/^\d+@(c\.us|s\.whatsapp\.net|lid)$/.test(m.chatId||'')) return;
    let phone=verifiedPhone || m.chatId.split('@')[0];
    if (!verifiedPhone && m.chatId.endsWith('@lid')) {
      if (m.senderPhone && bot.aliases.has(m.senderPhone)) phone=m.senderPhone;
      else {
      phone=lidCache.get(m.chatId);
      if (!phone) {const resolved=await api(base+'/contacts/'+encodeURIComponent(m.chatId)+'/phone');phone=resolved.phone;if(phone)lidCache.set(m.chatId,phone);}
      }
    }
    await bot.receive(m,phone);
  }

  // Recover a missed WebSocket notification from this contact's stored messages.
  // The API key, required chat filter, invitation time and age window all fence reads.
  async function pollIncoming() {
    if (polling || !providerReady || !bot?.active) return;
    polling=true;
    try {
      for (const phone of config.recipients) {
        const contact=store.contact(phone);
        if (!contact?.invited || contact.stopped) continue;
        const since=Math.max(contact.invitedAt,Date.now()-15*60000);
        const query=new URLSearchParams({chatId:phone+'@c.us',direction:'incoming',type:'text',
          since:String(since),orderBy:'timestamp',limit:'20',inlineMedia:'false'});
        const result=await api(base+'/messages?'+query);
        diagnostics.polls++;
        diagnostics.lastPollRows=result.messages?.length||0;
        const pending=(result.messages||[]).map(storedIncoming).filter(m=>m&&!store.seen(m.id)).sort((a,b)=>a.timestamp-b.timestamp);
        const stop=pending.findLast(m=>String(m.body||'').trim().toLowerCase()==='parar');
        for (const m of stop?[stop]:pending) {
          // Leave queued messages unseen while a live response or the pacing window is active.
          const current=store.contact(phone);
          if (!stop && (bot.busy.has(phone) || Date.now()-(current.lastReplyAt||0)<5000)) break;
          // The guarded REST selection resolved this phone through the persisted
          // LID directory already. Do not repeat a live lookup that can return null.
          await handleMessage(m,phone);
          if (store.seen(m.id)) diagnostics.recovered++;
        }
      }
    }catch(error){notice=error.message;}
    finally{polling=false;}
  }

  async function api(route, method='GET', body, idempotency) {
    const headers = { 'Content-Type':'application/json', 'X-API-Key':operatorKey };
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    const response = await fetch('http://127.0.0.1:2785/api' + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error('OpenWA HTTP ' + response.status + '. Verifique a sessão antes de repetir.');
    return response.json();
  }
  const base = '/sessions/' + session.id;
  async function generate(text, history = []) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
      method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey},
      body:JSON.stringify({ systemInstruction:{parts:[{text:SYSTEM_PROMPT}]}, contents:[
        ...history.map(turn=>({role:turn.role,parts:[{text:turn.text}]})), {role:'user',parts:[{text}]}],
        generationConfig:{maxOutputTokens:256} }), signal:AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error('Gemini HTTP ' + response.status + '. Nenhum reenvio automático.');
    const result = await response.json();
    const answer = result.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!answer) throw new Error('Gemini não retornou uma resposta de texto.');
    return answer;
  }
  const send = async (chatId,text,key) => {
    const result=await api(base + '/messages/send-text','POST',{chatId,text,linkPreview:false},key);
    notice='Mensagem enviada. Aguardando o participante.';
    return result;
  };

  async function ensureOperator() {
    if (operatorKey) return;
    const created = await createKey({name:'Laboratório local Gemini',role:'operator',allowedSessions:[session.id],
      allowedChats:config.recipients,expiresAt:new Date(Date.now()+2*60*60*1000).toISOString()});
    operatorKey = created.rawKey; keyId = created.apiKey.id;
  }

  async function configure(key) {
    if (configuring || sending) throw new Error('Já há uma operação em andamento.');
    if (typeof key !== 'string' || key.length < 16 || key.length > 512 || /\s/.test(key)) throw new Error('Chave inválida.');
    configuring = true;
    providerReady = false;
    if (bot) bot.active = false;
    try {
      geminiKey = key;
      await generate('Responda apenas: teste pronto.');
      await ensureOperator();
      const current = await api(base);
      sessionReady = current.status === 'ready';
      if (!sessionReady) throw new Error('WhatsApp ainda não está conectado.');
      bot = new StudyBot({recipients:config.recipients,store,send,generate});
      for (const phone of config.recipients) {
        // The public number-lookup route deliberately refuses chat-scoped keys.
        // Only the owner's local setup can resolve the configured number;
        // the bot's key remains restricted before any event is subscribed to.
        const whatsappId = await checkNumber(session.id,phone);
        if (!whatsappId) throw new Error('O contato final '+phone.slice(-4)+' não pôde ser confirmado no WhatsApp.');
        bot.addResolvedAlias(phone,whatsappId);
        chatIds.set(phone,whatsappId);
      }
      const aliases = [...new Set([...config.recipients,...[...chatIds.values()].map(x=>x.split('@')[0])])];
      await updateKey(keyId,{allowedChats:aliases});
      if (socket) socket.disconnect();
      socket = io('http://127.0.0.1:2785/events',{auth:{apiKey:operatorKey},transports:['websocket'],autoConnect:false});
      subscribed = false;
      socket.on('connect',()=>socket.emit('message',{type:'subscribe',sessionId:session.id,events:['message.received']}));
      socket.on('disconnect',()=>{subscribed=false;});
      socket.on('connect_error',()=>{notice='Não foi possível conectar ao fluxo de mensagens.';});
      socket.on('message',async frame=>{
        if (frame.type === 'subscribed') {subscribed=true;bot.active=true;notice='IA pronta. Revise o convite e clique em enviar.';return;}
        if (frame.type === 'error') {subscribed=false;notice='A conexão de eventos recusou a autorização.';return;}
        const p=frame.payload;
        if (frame.type!=='event'||p?.event!=='message.received'||p.sessionId!==session.id||!bot?.active) return;
        diagnostics.events++;diagnostics.lastEventAt=Date.now();
        const m=p.data;
        try {
          await handleMessage(m);
        } catch(error) {notice=error.message;}
      });
      socket.connect();
      providerReady = true;
    } catch(error) {notice=error.message;throw error;}
    finally {configuring=false;}
  }

  async function inviteAll() {
    if (!providerReady || !subscribed || !bot?.active || sending) throw new Error('Valide Gemini e a conexão antes de enviar.');
    sending=true;
    try {
      for (const phone of config.recipients) {
        await bot.invite(phone,chatIds.get(phone));
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      notice='Convites processados. A IA responderá aos participantes que digitarem oi.';
    } catch(error) {notice=error.message;throw error;}
    finally {sending=false;}
  }

  const page = fs.readFileSync(path.join(__dirname,'estudo-ai.html'),'utf8');
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host;
    const origin=req.headers.origin;
    if (!['127.0.0.1:2887','localhost:2887'].includes(host) || req.headers['sec-fetch-site']==='cross-site' ||
        (origin && !['http://127.0.0.1:2887','http://localhost:2887'].includes(origin))) {res.writeHead(403);return res.end();}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'");
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page);}
    if(req.method==='GET'&&req.url==='/connection'){
      try {
        const current=await api(base);
        // QR recovery is an owner-only local operation, not a capability of the chat-scoped bot key.
        const qr=current.status==='qr_ready'?await getQr(session.id):null;
        return json(200,{status:current.status,qrCode:qr?.qrCode||null});
      }catch{return json(503,{error:'Não foi possível consultar a conexão.'});}
    }
    if(req.method==='GET'&&req.url==='/state')return json(200,{csrf,notice,model:MODEL,configured:providerReady,connected:subscribed,sending,
      active:!!bot?.active,intro:INTRO,diagnostics,contacts:config.recipients.map(phone=>({ending:phone.slice(-4),...(()=>{const c=store.contact(phone);return {invited:!!c?.invited,claimed:!!c?.claim,consented:!!c?.consented,stopped:!!c?.stopped,replies:c?.replies||0};})()}))});
    if(req.method!=='POST'||!['/configure','/invite','/stop','/shutdown'].includes(req.url))return json(404,{error:'Rota não encontrada.'});
    if(!origin||req.headers['x-study-csrf']!==csrf)return json(403,{error:'Recarregue a página antes de continuar.'});
    let raw='';
    try {
      for await (const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096){return json(413,{error:'Entrada muito grande.'});}}
      const body=raw?JSON.parse(raw):{};
      if(req.url==='/configure')await configure(body.key);
      if(req.url==='/invite'){
        if(body.confirm!==true)throw new Error('Confirme o texto e os contatos antes de enviar.');
        await inviteAll();
      }
      if(req.url==='/stop'){if(bot)bot.active=false;notice='IA pausada. Nenhuma nova resposta será enviada.';}
      if(req.url==='/shutdown'){
        if(sending)throw new Error('Aguarde o envio em andamento antes de encerrar.');
        if(bot)bot.active=false;
        json(200,{ok:true});
        setImmediate(async()=>{
          try{clearInterval(pollTimer);socket?.disconnect();server.close();await shutdown();db.close();process.exit(0);}
          catch{process.exit(1);}
        });
        return;
      }
      return json(200,{ok:true});
    }catch(error){return json(400,{error:error.message});}
  });
  await ensureOperator();
  const pollTimer=setInterval(()=>void pollIncoming(),3000);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(2887,'127.0.0.1',resolve);});
  if (session.status === 'failed' || session.status === 'disconnected') {
    notice='Reconectando a sessão do WhatsApp…';
    void startSession(session.id).then(()=>{notice='WhatsApp iniciado. Insira a chave Gemini para validar.';})
      .catch(()=>{notice='A sessão precisa ser reconectada pelo painel OpenWA.';});
  }
  return {close:()=>{clearInterval(pollTimer);if(bot)bot.active=false;socket?.disconnect();server.close();db.close();}};
}

module.exports = {startStudyServer};
