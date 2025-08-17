
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async ()=>{
  try { await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`); } catch(e) {}
  await db.appUser.upsert({ where:{ id:'00000000-0000-0000-0000-000000000101' }, update:{}, create:{ id:'00000000-0000-0000-0000-000000000101', role:'customer', name:'Alice' }});
  await db.merchant.upsert({ where:{ id:'10000000-0000-0000-0000-000000000111' }, update:{}, create:{ id:'10000000-0000-0000-0000-000000000111', name:'Demo Mart', serviceClass:'food_mart', lat:12.93538, lng:77.61545, prepTimeSec:1200 }});
  await db.partner.upsert({ where:{ id:'00000000-0000-0000-0000-000000000201' }, update:{ status:'idle', lat:12.9349, lng:77.6135 }, create:{ id:'00000000-0000-0000-0000-000000000201', name:'Ravi', vehicleType:'bike', status:'idle', lat:12.9349, lng:77.6135, rating:4.9 }});
  console.log("✓ Seeded baseline users/merchant/partner");
  process.exit(0);
})().catch(e=>{ console.error(e); process.exit(1); });
