
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const USE_MOCK = process.env.USE_MOCK === '1';
const OLA_KEY = process.env.OLA_MAPS_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192';
const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 6);
const AGENT_MIN_INTERVAL_MS = Number(process.env.AGENT_MIN_INTERVAL_MS || 1500);

const app = express();
app.use(express.json({ limit: '3mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const db = new PrismaClient();

function now(){ return Date.now(); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
const rooms = new Map();
function join(ws, room){ if(!rooms.has(room)) rooms.set(room, new Set()); rooms.get(room).add(ws); }
function leave(ws){ for(const set of rooms.values()) set.delete(ws); }
function broadcast(room, msg){
  const set = rooms.get(room); if(!set) return;
  const raw = JSON.stringify(msg);
  for(const c of set) try{ c.send(raw); }catch{}
}

wss.on('connection', ws=>{
  ws.on('message', raw=>{
    try{ const m = JSON.parse(raw.toString());
      if(m.type==='join') join(ws, m.room);
      if(m.type==='send' && m.room) broadcast(m.room, m.msg);
    }catch{}
  });
  ws.on('close', ()=> leave(ws));
});

const lastCallAt = new Map();
function tooSoon(key){
  const last = lastCallAt.get(key) || 0;
  const ok = (now()-last) >= AGENT_MIN_INTERVAL_MS;
  if(ok) lastCallAt.set(key, now());
  return !ok;
}
const orderLocks = new Set();
async function withOrderLock(orderId, fn){
  const key = `order:${orderId}`;
  while(orderLocks.has(key)) await sleep(50);
  orderLocks.add(key);
  try{ return await fn(); } finally { orderLocks.delete(key); }
}

async function directions(origin, destination, { alternatives, traffic_metadata, overview }={}){
  if (USE_MOCK || !OLA_KEY) {
    return { routes:[{ summary:'mock', overview_polyline:'}_seFqv}uMd@f@', readable_duration:'10 min', readable_distance:'2.1 km', travel_advisory:{} }] };
  }
  const url = `https://api.olamaps.io/routing/v1/directions?origin=${origin}&destination=${destination}&alternatives=${!!alternatives}&traffic_metadata=${!!traffic_metadata}&overview=${overview||'full'}`;
  const res = await fetch(url, { headers: { 'X-API-Key': OLA_KEY } });
  if(!res.ok){ throw new Error('OlaMaps error '+res.status); }
  return await res.json();
}

async function pushMessage(orderId, role, text, meta){
  const m = await db.message.create({ data: { orderId, role, text, meta } });
  broadcast(`order:${orderId}`, { type:'MESSAGE', message: { role, text, meta, createdAt: m.createdAt } });
  if(role === 'partner' && meta?.partnerId) broadcast(`partner:${meta.partnerId}`, { type:'MESSAGE', message: { role:'agent', text, meta, createdAt: m.createdAt } });
  if(role === 'merchant' && meta?.merchantId) broadcast(`merchant:${meta.merchantId}`, { type:'MESSAGE', message: { role:'agent', text, meta, createdAt: m.createdAt } });
  if(role === 'ops') broadcast('ops', { type:'MESSAGE', message:{ role:'agent', text, meta } });
  return m;
}
async function pushOrderUpdate(orderId, payload){
  broadcast(`order:${orderId}`, { type:'ORDER_UPDATE', orderId, ...payload });
}

async function tool_route_check_best({ orderId }){
  const o = await db.order.findUnique({ where:{ id: orderId }, include:{ routes:{ orderBy: { createdAt: 'desc' }, take:1 } } });
  if(!o) throw new Error('order-not-found');
  const origin = `${o.pickupLat},${o.pickupLng}`;
  const dest = `${o.dropLat},${o.dropLng}`;
  const data = await directions(origin, dest, { alternatives:true, traffic_metadata:true, overview:'full' });
  const baseSec = o.etaSec || 12*60;
  const altGain = USE_MOCK ? 180 + Math.floor(Math.random()*240) : 0; // 3-7 min
  const gainSec = altGain;
  if(gainSec <= 120) return { better:false, gainSec:0 };
  const msg = {
    type:'REROUTE_PROPOSAL',
    orderId,
    partnerId: o.partnerId,
    current: { etaSec: baseSec, distanceM: 6000 },
    alternate: { etaSec: Math.max(300, baseSec - gainSec), distanceM: 5200 },
    reason: 'Traffic ahead, alternate is faster',
    expiresInSec: 180
  };
  broadcast(`partner:${o.partnerId}`, msg);
  return { better:true, proposal: msg };
}
async function tool_re_route_driver({ orderId }){
  const o = await db.order.findUnique({ where:{ id: orderId } });
  if(!o) throw new Error('order-not-found');
  const origin = `${o.pickupLat},${o.pickupLng}`;
  const dest = `${o.dropLat},${o.dropLng}`;
  const data = await directions(origin, dest, { alternatives:true, traffic_metadata:true, overview:'full' });
  const overview = data?.routes?.[0]?.overview_polyline || '}_seFqv}uMd@f@';
  await db.routeSnapshot.create({ data: { orderId, originLat:o.pickupLat, originLng:o.pickupLng, destLat:o.dropLat, destLng:o.dropLng, overviewPolyline: overview, readableDuration: data?.routes?.[0]?.readable_duration || '8 min', readableDistance: data?.routes?.[0]?.readable_distance || '1.9 km' } });
  await db.order.update({ where:{ id: orderId }, data:{ etaSec: Math.max(300, (o.etaSec||600)-240), status: o.status==='assigned'?'en_route_pickup':o.status } });
  await pushOrderUpdate(orderId, { etaSec: Math.max(300, (o.etaSec||600)-240) });
  await pushMessage(orderId, 'partner', 'Updated route applied. Please follow the highlighted path.', { partnerId: o.partnerId });
  return { ok:true };
}
async function tool_where_is_partner({ orderId }){
  const o = await db.order.findUnique({ where:{ id: orderId }, include:{ partner:true } });
  if(!o || !o.partner) throw new Error('no-partner');
  const p = o.partner;
  const km = Math.sqrt(((p.lat||0)-(o.dropLat||0))**2 + ((p.lng||0)-(o.dropLng||0))**2) * 111;
  const etaMin = Math.round(Math.max(2, km / 0.3));
  const text = `Your delivery partner is near (${(p.lat||0).toFixed(4)}, ${(p.lng||0).toFixed(4)}). Estimated arrival in ~${etaMin} minutes.`;
  await pushMessage(orderId, 'customer', text, { partnerId: p.id });
  await pushOrderUpdate(orderId, { etaSec: etaMin*60 });
  return { lat:p.lat, lng:p.lng, etaMin };
}
async function tool_set_order_delay({ orderId, minutes, reason }){
  const o = await db.order.findUnique({ where:{ id: orderId } });
  if(!o) throw new Error('order-not-found');
  const add = Math.max(2, Math.min(120, Number(minutes)||10));
  const newEta = (o.etaSec||600) + add*60;
  await db.order.update({ where:{ id: orderId }, data:{ etaSec: newEta, status: o.status==='pending'?'preparing':o.status } });
  await pushOrderUpdate(orderId, { etaSec: newEta, status: 'preparing' });
  await pushMessage(orderId, 'customer', `Merchant reports a delay of ~${add} minutes. Sorry for the wait.`, { merchantId: o.merchantId });
  await pushMessage(orderId, 'partner', `Merchant delay of ~${add} minutes.` , { partnerId: o.partnerId });
  await pushMessage(orderId, 'ops', `Delay for order ${orderId}: +${add} min (${reason||'unspecified'})`, {});
  return { ok:true, newEta };
}
async function tool_notify_customer({ orderId, text, voucher }){
  await pushMessage(orderId, 'customer', text, { voucher });
  return { ok:true };
}
async function tool_notify_partner({ orderId, text }){
  const o = await db.order.findUnique({ where:{ id: orderId } });
  await pushMessage(orderId, 'partner', text, { partnerId: o?.partnerId });
  return { ok:true };
}
async function tool_notify_merchant({ orderId, text }){
  const o = await db.order.findUnique({ where:{ id: orderId } });
  await pushMessage(orderId, 'merchant', text, { merchantId: o?.merchantId });
  return { ok:true };
}
async function tool_notify_ops({ orderId, text }){
  await pushMessage(orderId, 'ops', text, {});
  return { ok:true };
}
async function tool_get_merchant_status({ merchantId }){
  const m = await db.merchant.findUnique({ where:{ id: merchantId }});
  return { isOpen: m?.isOpen ?? false, prepTimeSec: m?.prepTimeSec ?? 900 };
}
async function tool_get_nearby_merchants({ lat, lng }){
  return { merchants: [{ id:'m2', name:'Alt Mart', lat:lat+0.002, lng:lng+0.002 }] };
}

const TOOLS = {
  route_check_best: tool_route_check_best,
  re_route_driver: tool_re_route_driver,
  where_is_partner: tool_where_is_partner,
  set_order_delay: tool_set_order_delay,
  notify_customer: tool_notify_customer,
  notify_partner: tool_notify_partner,
  notify_merchant: tool_notify_merchant,
  notify_ops: tool_notify_ops,
  get_merchant_status: tool_get_merchant_status,
  get_nearby_merchants: tool_get_nearby_merchants,
};

async function callToolLogged(tool, input, ctx){
  const t0 = Date.now();
  let status='ok', resp=null, err=null;
  try{ resp = await TOOLS[tool](input); }
  catch(e){ status='error'; err=String(e); }
  const latency = Date.now()-t0;
  await db.toolCallLog.create({ data: { tool, request: input, response: (status==='ok'?resp:{ error: err }), status, latencyMs: latency, orderId: ctx.orderId, role: ctx.actorRole } });
  if(status!=='ok') throw new Error(err);
  return resp;
}

async function llmPlan({ actorRole, text, orderId, merchantId, partnerId, customerId }){
  const sys = `You are Synapse, a logistics incident coordinator for last-mile deliveries.
Decide concrete tool calls to resolve the user's request.
Return ONLY strict JSON: {"steps":[{"tool":"<name>","input":{...}}, ...]}
Available tools: ${Object.keys(TOOLS).join(', ')}
Rules:
- For "delay" from merchant: call set_order_delay with minutes and a reason, then notify_customer and notify_partner.
- For partner asking better route: call route_check_best; if better, you can stop (proposal is pushed); if accepted later, server will call re_route_driver.
- For customer "where is": call where_is_partner.
- Keep steps <= ${AGENT_MAX_STEPS}.`;

  const user = `Context: {"orderId":"${orderId||''}","merchantId":"${merchantId||''}","partnerId":"${partnerId||''}","customerId":"${customerId||''}","actorRole":"${actorRole}"}
User says: ${JSON.stringify(text)}`;

  if (USE_MOCK || !GROQ_KEY){
    let steps=[];
    const s = (text||'').toLowerCase();
    const delayMatch = s.match(/(\\d+)\\s*(min|mins|minutes)/);
    if(actorRole==='merchant' && (s.includes('delay')||s.includes('late'))){
      const minutes = delayMatch ? Number(delayMatch[1]) : 15;
      steps = [
        { tool:'set_order_delay', input:{ orderId, minutes, reason: text } },
        { tool:'notify_customer', input:{ orderId, text:`Merchant reports delay of ~${minutes} minutes.` } },
        { tool:'notify_partner', input:{ orderId, text:`Merchant delay ~${minutes} minutes.` } }
      ];
    } else if(actorRole==='partner' && (s.includes('better route')||s.includes('shortcut')||s.includes('faster'))){
      steps = [ { tool:'route_check_best', input:{ orderId } } ];
    } else if(actorRole==='customer' && (s.includes('where')||s.includes('eta')||s.includes('when'))){
      steps = [ { tool:'where_is_partner', input:{ orderId } } ];
    } else {
      steps = [ { tool:'notify_ops', input:{ orderId, text:`Unhandled: ${text}` } } ];
    }
    return { steps };
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role:'system', content: sys },
        { role:'user', content: user }
      ],
      temperature: 0.2
    })
  });
  if(!res.ok){
    return { steps:[ { tool:'notify_ops', input:{ orderId, text:`LLM error ${res.status}` } } ] };
  }
  const data = await res.json();
  const txt = data.choices?.[0]?.message?.content || '{}';
  try{
    const plan = JSON.parse(txt);
    if(!Array.isArray(plan.steps)) throw new Error('bad-plan');
    return { steps: plan.steps.slice(0, AGENT_MAX_STEPS) };
  }catch(e){
    return { steps:[ { tool:'notify_ops', input:{ orderId, text:`LLM parse error: ${e}` } } ] };
  }
}

async function runAgent({ actorRole, actorId, orderId, text }){
  if(tooSoon(`${actorRole}:${actorId||'anon'}`)){
    return { status:'rate_limited' };
  }
  return await withOrderLock(orderId, async ()=>{
    const run = await db.agentRun.create({ data:{ orderId, actorRole, actorId, prompt: text, status:'planning' } });
    const plan = await llmPlan({ actorRole, text, orderId, merchantId: null, partnerId: null, customerId: null });
    await db.agentRun.update({ where:{ id: run.id }, data:{ plan, status:'executing' } });
    for(const step of plan.steps){
      const { tool, input } = step;
      if(!TOOLS[tool]){ await callToolLogged('notify_ops', { orderId, text:`Unknown tool ${tool}` }, { orderId, actorRole }); continue; }
      await callToolLogged(tool, input||{}, { orderId, actorRole });
    }
    await db.agentRun.update({ where:{ id: run.id }, data:{ status:'done' } });
    return { status:'ok', runId: run.id, steps: plan.steps };
  });
}

// APIs
app.post('/api/food-mart/orders', async (req,res)=>{
  try{
    const dto = { ...req.body, class: 'food_mart', status: 'pending' };
    const o = await db.order.create({ data: dto });
    if (o.pickupLat && o.pickupLng && o.dropLat && o.dropLng){
      const origin = `${o.pickupLat},${o.pickupLng}`;
      const dest = `${o.dropLat},${o.dropLng}`;
      const data = await directions(origin, dest, { alternatives:true, traffic_metadata:true, overview:'full' });
      const overview = data?.routes?.[0]?.overview_polyline || '}_seFqv}uMd@f@';
      await db.routeSnapshot.create({ data: { orderId:o.id, originLat:o.pickupLat, originLng:o.pickupLng, destLat:o.dropLat, destLng:o.dropLng, overviewPolyline: overview, readableDuration: data?.routes?.[0]?.readable_duration || '10 min', readableDistance: data?.routes?.[0]?.readable_distance || '2.0 km' } });
      await db.order.update({ where:{ id:o.id }, data:{ etaSec: 10*60 }});
    }
    res.json(await db.order.findUnique({ where:{ id:o.id }, include:{ routes:true } }));
  }catch(e){ console.error(e); res.status(500).json({ error: String(e) }); }
});

app.post('/api/express/orders', async (req,res)=>{
  try{ const out = await db.order.create({ data: { ...req.body, class:'express', status:'pending' } }); res.json(out); }
  catch(e){ console.error(e); res.status(500).json({ error: String(e) }); }
});

app.post('/api/car/rides', async (req,res)=>{
  try{ const out = await db.order.create({ data: { ...req.body, class:'car', status:'pending' } }); res.json(out); }
  catch(e){ console.error(e); res.status(500).json({ error: String(e) }); }
});

app.get('/api/orders/:id', async (req,res)=>{
  const o = await db.order.findUnique({ where:{ id:req.params.id }, include:{ routes:{ orderBy:{ createdAt:'desc' }, take:1 }, assignment:true, partner:true, merchant:true } });
  if(!o) return res.status(404).json({ error:'not found' });
  res.json(o);
});
app.get('/api/orders/:id/tracking', async (req,res)=>{
  const o = await db.order.findUnique({ where:{ id:req.params.id }, include:{ routes:{ orderBy:{ createdAt:'desc' }, take:1 }, partner:true } });
  if(!o) return res.status(404).json({ error:'not found' });
  res.json({ status:o.status, etaSec:o.etaSec, pickup:{ lat:o.pickupLat, lng:o.pickupLng }, drop:{ lat:o.dropLat, lng:o.dropLng }, partner:o.partner, route:o.routes?.[0] || null });
});

app.get('/api/partner/:partnerId/orders', async (req,res)=>{
  const xs = await db.order.findMany({ where:{ partnerId:req.params.partnerId }, include:{ routes:{ orderBy:{ createdAt:'desc' }, take:1 } } });
  res.json(xs);
});
app.get('/api/merchant/:merchantId/orders', async (req,res)=>{
  const xs = await db.order.findMany({ where:{ merchantId:req.params.merchantId }, include:{ routes:{ orderBy:{ createdAt:'desc' }, take:1 } } });
  res.json(xs);
});

function euclid(a,b){ return Math.sqrt(((a.lat||0)-(b.lat||0))**2 + ((a.lng||0)-(b.lng||0))**2); }
app.post('/api/dispatch/assign', async (req,res)=>{
  const { orderIds } = req.body || {};
  const orders = await db.order.findMany({ where:{ id: { in: orderIds }, partnerId: null, status: { in: ['pending','accepted','preparing'] }}});
  const partners = await db.partner.findMany({ where:{ status: 'idle' }});
  if(orders.length===0||partners.length===0) return res.json({ assignments: [] });
  const cost = orders.map(o => partners.map(p => euclid({lat:p.lat,lng:p.lng},{lat:o.pickupLat,lng:o.pickupLng})));
  const pairs=[];
  for(let i=0;i<orders.length;i++){
    let bestJ=0, best=1e9;
    for(let j=0;j<partners.length;j++){ if(cost[i][j]<best){ best=cost[i][j]; bestJ=j; } }
    pairs.push({ i, j: bestJ });
  }
  const out=[];
  for(const pr of pairs){
    const o=orders[pr.i], p=partners[pr.j];
    try{
      const result = await db.$transaction(async(tx)=>{
        const fresh = await tx.order.findUnique({ where:{ id: o.id }});
        const pFresh = await tx.partner.findUnique({ where:{ id: p.id }});
        if(!fresh || fresh.partnerId) throw new Error('order-already-assigned');
        if(!pFresh || pFresh.status !== 'idle') throw new Error('partner-not-idle');
        await tx.assignment.create({ data:{ orderId:o.id, partnerId:p.id, algorithm:'greedy', score: cost[pr.i][pr.j], accepted:true } });
        await tx.order.update({ where:{ id:o.id }, data:{ partnerId:p.id, status:'assigned' }});
        await tx.partner.update({ where:{ id:p.id }, data:{ status:'on_trip' }});
        broadcast(`partner:${p.id}`, { type:'ASSIGNED', orderId:o.id });
        broadcast(`order:${o.id}`, { type:'ORDER_UPDATE', orderId:o.id, status:'assigned' });
        return { orderId:o.id, partnerId:p.id };
      });
      out.push(result);
    }catch(e){}
  }
  res.json({ assignments: out });
});

app.post('/api/orders/:id/status', async (req,res)=>{
  const { status } = req.body || {};
  const o = await db.order.findUnique({ where:{ id:req.params.id }});
  if(!o) return res.status(404).json({ error:'not-found' });
  const upd = await db.$transaction(async(tx)=>{
    const ord = await tx.order.update({ where:{ id:o.id }, data:{ status } });
    if((status==='completed' || status==='cancelled') && ord.partnerId){
      await tx.partner.update({ where:{ id: ord.partnerId }, data:{ status:'idle' }});
    }
    return ord;
  });
  await pushOrderUpdate(o.id, { status: upd.status });
  res.json(upd);
});

app.post('/api/partner/:partnerId/location', async (req,res)=>{
  const { lat, lng } = req.body || {};
  const p = await db.partner.update({ where:{ id:req.params.partnerId }, data:{ lat, lng, lastHeartbeat: new Date() } });
  const orders = await db.order.findMany({ where:{ partnerId: p.id, status:{ in:['assigned','en_route_pickup','en_route_dropoff'] }}, select:{ id:true } });
  for(const o of orders){ broadcast(`order:${o.id}`, { type:'LOCATION', partnerId: p.id, lat, lng, orderId: o.id }); }
  res.json({ ok:true });
});

app.get('/api/chat/feed/:orderId', async (req,res)=>{
  const xs = await db.message.findMany({ where:{ orderId: req.params.orderId }, orderBy:{ createdAt: 'asc' }, take: 200 });
  res.json(xs);
});

app.post('/api/merchant/:merchantId/report-delay', async (req,res)=>{
  const { orderId, text } = req.body||{};
  if(!orderId || !text) return res.status(400).json({ error:'orderId and text required' });
  if(tooSoon(`merchant:${req.params.merchantId}`)) return res.status(429).json({ error:'too_soon' });
  const out = await runAgent({ actorRole:'merchant', actorId:req.params.merchantId, orderId, text });
  res.json(out);
});
app.post('/api/partner/:partnerId/ask', async (req,res)=>{
  const { orderId, text } = req.body||{};
  if(!orderId || !text) return res.status(400).json({ error:'orderId and text required' });
  if(tooSoon(`partner:${req.params.partnerId}`)) return res.status(429).json({ error:'too_soon' });
  const out = await runAgent({ actorRole:'partner', actorId:req.params.partnerId, orderId, text });
  res.json(out);
});
app.post('/api/customer/:customerId/ask', async (req,res)=>{
  const { orderId, text } = req.body||{};
  if(!orderId || !text) return res.status(400).json({ error:'orderId and text required' });
  if(tooSoon(`customer:${req.params.customerId}`)) return res.status(429).json({ error:'too_soon' });
  const out = await runAgent({ actorRole:'customer', actorId:req.params.customerId, orderId, text });
  res.json(out);
});

app.post('/api/partner/:partnerId/reroute/:orderId/accept', async (req,res)=>{
  try{
    const r = await callToolLogged('re_route_driver', { orderId: req.params.orderId }, { orderId: req.params.orderId, actorRole:'partner' });
    res.json(r);
  }catch(e){ res.status(500).json({ error:String(e) }); }
});
app.post('/api/partner/:partnerId/reroute/:orderId/decline', async (req,res)=>{
  await pushMessage(req.params.orderId, 'partner', 'Reroute declined. Continuing on current route.', { partnerId: req.params.partnerId });
  res.json({ ok:true });
});

const uploadDir = path.join(__dirname, 'uploads');
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ storage: multer.diskStorage({
  destination: (_, __, cb)=> cb(null, uploadDir),
  filename: (_, file, cb)=> cb(null, Date.now() + '-' + file.originalname)
})});
app.post('/api/evidence/upload', upload.single('file'), (req,res)=>{
  res.json({ url: '/uploads/' + path.basename(req.file.path) });
});
app.use('/uploads', express.static(uploadDir));

app.get('/api/ops/logs', async (req,res)=>{
  const logs = await db.toolCallLog.findMany({ orderBy:{ createdAt:'desc' }, take: 200 });
  const msgs = await db.message.findMany({ orderBy:{ createdAt:'desc' }, take: 200 });
  const runs = await db.agentRun.findMany({ orderBy:{ createdAt:'desc' }, take: 100 });
  res.json({ logs, msgs, runs });
});

app.post('/api/route/directions', async (req,res)=>{
  try{
    const { origin, destination, alternatives, traffic_metadata, overview } = req.body || {};
    const data = await directions(origin, destination, { alternatives, traffic_metadata, overview });
    res.json(data);
  }catch(e){ console.error(e); res.status(500).json({ error: String(e) }); }
});

function mountSpa(routeBase, distPath){
  app.use(routeBase, express.static(distPath, { index: 'index.html' }));
  app.get(routeBase+'/*', (req,res)=> res.sendFile(path.join(distPath, 'index.html')));
}
mountSpa('/merchant', path.join(__dirname, 'apps/merchant-ui/dist'));
mountSpa('/partner',  path.join(__dirname, 'apps/partner-ui/dist'));
mountSpa('/customer', path.join(__dirname, 'apps/customer-ui/dist'));
mountSpa('/ops',      path.join(__dirname, 'apps/ops-ui/dist'));

app.get('/', (req,res)=>{
  res.type('html').send(`<h1>GrabHack Monolith (Postgres + Synapse Agent)</h1>
    <ul>
      <li><a href="/merchant">Merchant UI</a></li>
      <li><a href="/partner">Partner UI</a></li>
      <li><a href="/customer">Customer UI</a></li>
      <li><a href="/ops">Ops UI</a></li>
    </ul>
    <p>API base: <code>/api</code> — WebSocket: <code>ws://HOST/ws</code></p>`);
});

server.listen(PORT, ()=> console.log('Monolith (PG+Synapse) running at http://localhost:'+PORT));
