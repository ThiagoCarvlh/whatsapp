'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {StudyBot,storedIncoming} = require('./estudo-ai-core.cjs');
const PHONE = '5511999990001';
const CHAT = PHONE+'@c.us';
const NOW = 1800000000000;
function setup({generate = async()=> 'Resposta de teste',store:provided,recipients=[PHONE],now=()=>NOW}={}) {
  const contacts = new Map(), seen = new Set(), calls = [], prompts = [];
  const store = provided || {
    contact:p=>contacts.has(p)?{...contacts.get(p)}:undefined,
    claimInvite:(p,key,time)=>{if(contacts.has(p))return false;contacts.set(p,{invited:false,invitedAt:time,replies:0});return true;},
    inviteSent:p=>{contacts.get(p).invited=true;},
    claimMessage:id=>{if(seen.has(id))return false;seen.add(id);return true;},
    stop:p=>{contacts.get(p).stopped=true;},
    beginReply:(p,time)=>Object.assign(contacts.get(p),{consented:true,replies:contacts.get(p).replies+1,lastReplyAt:time}),
  };
  const bot=new StudyBot({recipients,store,send:async(...args)=>calls.push(args),
    generate:async (text,history)=>{prompts.push(text);return generate(text,history);},now});
  bot.active=true;
  const message=(changes={})=>({id:'m1',chatId:CHAT,body:'oi',type:'text',timestamp:NOW/1000,fromMe:false,isGroup:false,...changes});
  return {bot,store,calls,prompts,message};
}
test('não chama Gemini nem envia antes de convite e confirmação',async()=>{
  const t=setup();await t.bot.receive(t.message(),PHONE);assert.equal(t.prompts.length,0);
  await t.bot.invite(PHONE,CHAT);await t.bot.receive(t.message({body:'qualquer texto'}),PHONE);
  assert.equal(t.prompts.length,0);assert.equal(t.calls.length,1);
});
test('oi permite uma resposta apenas no chat de origem',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);await t.bot.receive(t.message(),PHONE);
  assert.deepEqual(t.prompts,['oi']);assert.equal(t.calls.length,2);assert.equal(t.calls[1][0],CHAT);
});
test('outro contato, grupo e mensagem própria não chegam ao provedor',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  await t.bot.receive(t.message(), '5511888880002');
  await t.bot.receive(t.message({isGroup:true}), PHONE);
  await t.bot.receive(t.message({fromMe:true}), PHONE);
  assert.equal(t.prompts.length,0);assert.equal(t.calls.length,1);
});
test('não infere telefone a partir dos dígitos de um lid',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);await t.bot.receive(t.message({chatId:PHONE+'@lid'}),undefined);
  assert.equal(t.prompts.length,0);
});
test('mensagem repetida ou concorrente não gera duas respostas',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  await Promise.all([t.bot.receive(t.message(),PHONE),t.bot.receive(t.message(),PHONE)]);
  assert.equal(t.prompts.length,1);assert.equal(t.calls.length,2);
});
test('convite não se repete ao reconstruir o bot com o mesmo diário',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  const second=setup({store:t.store});await second.bot.invite(PHONE,CHAT);
  assert.equal(second.calls.length,0);
});
test('parar impede mensagens seguintes sem chamar Gemini',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  await t.bot.receive(t.message({body:'parar'}),PHONE);
  await t.bot.receive(t.message({id:'m2'}),PHONE);assert.equal(t.prompts.length,0);
});
test('parar durante geração cancela a resposta pendente',async()=>{
  let finish;const answer=new Promise(r=>{finish=r;});
  const t=setup({generate:()=>answer});await t.bot.invite(PHONE,CHAT);
  const pending=t.bot.receive(t.message(),PHONE);
  await t.bot.receive(t.message({id:'stop',body:'parar'}),PHONE);
  finish('Resposta tardia');await pending;
  assert.equal(t.calls.length,2);assert.match(t.calls[1][1],/encerrado/);
});
test('limite de respostas bloqueia antes de chamar Gemini',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  for(let i=0;i<12;i++)t.store.beginReply(PHONE,NOW-10000);
  await t.bot.receive(t.message(),PHONE);assert.equal(t.prompts.length,0);
});
test('mensagem antiga e mídia não são processadas',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  await t.bot.receive(t.message({timestamp:(NOW-1200000)/1000}),PHONE);
  await t.bot.receive(t.message({type:'image'}),PHONE);assert.equal(t.prompts.length,0);
});

test('recuperação REST e evento ao vivo compartilham deduplicação',async()=>{
  const t=setup();await t.bot.invite(PHONE,CHAT);
  const row={id:'database-uuid',waMessageId:'m1',direction:'incoming',type:'text',chatId:CHAT,body:'oi',timestamp:NOW/1000};
  await t.bot.receive(storedIncoming(row),PHONE);
  await t.bot.receive(t.message(),PHONE);
  assert.equal(t.prompts.length,1);assert.equal(t.calls.length,2);
  assert.equal(storedIncoming({...row,direction:'outgoing'}),null);
  assert.equal(storedIncoming({...row,chatId:'123@g.us'}),null);
  assert.equal(storedIncoming({...row,waMessageId:null}),null);
});

test('recupera oi após o convite em até quinze minutos, sem ler mensagens anteriores',async()=>{
  let clock=NOW;const t=setup({now:()=>clock});await t.bot.invite(PHONE,CHAT);
  clock+=10*60000;
  await t.bot.receive(t.message({id:'before',timestamp:(NOW-1000)/1000}),PHONE);
  assert.equal(t.prompts.length,0);
  await t.bot.receive(t.message({timestamp:(NOW+1000)/1000}),PHONE);
  assert.equal(t.prompts.length,1);
});
test('erro do provedor não dispara resposta ou repetição automática',async()=>{
  const t=setup({generate:async()=>{throw new Error('indisponível');}});await t.bot.invite(PHONE,CHAT);
  await assert.rejects(t.bot.receive(t.message(),PHONE),/indisponível/);
  await t.bot.receive(t.message(),PHONE);assert.equal(t.prompts.length,1);assert.equal(t.calls.length,1);
});

test('histórico mantém seis interações e não mistura contatos',async()=>{
  const other='5511888880002', histories=[];let clock=NOW;
  const t=setup({recipients:[PHONE,other],now:()=>clock,
    generate:async(text,history)=>{histories.push(history);return 'Resposta: '+text;}});
  await t.bot.invite(PHONE,CHAT);await t.bot.invite(other,other+'@c.us');
  await t.bot.receive(t.message(),PHONE);
  for(let i=1;i<=7;i++){
    clock+=6000;
    await t.bot.receive(t.message({id:'next'+i,body:'banho e tosa '+i,timestamp:clock/1000}),PHONE);
  }
  assert.deepEqual(histories[1],[{role:'user',text:'oi'},{role:'model',text:'Resposta: oi'}]);
  assert.equal(histories[7].length,12);assert.equal(histories[7][0].text,'banho e tosa 1');
  await t.bot.receive(t.message({id:'other',chatId:other+'@c.us',timestamp:clock/1000}),other);
  assert.deepEqual(histories.at(-1),[]);
  await t.bot.receive(t.message({id:'stop-memory',body:'parar',timestamp:clock/1000}),PHONE);
  assert.equal(t.bot.history.has(PHONE),false);
});
