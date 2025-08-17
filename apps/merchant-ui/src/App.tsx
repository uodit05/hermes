
import { useEffect, useState } from 'react'

const MERCHANT_ID = '10000000-0000-0000-0000-000000000111'

export default function App(){
  const [orders,setOrders] = useState<any[]>([])

  useEffect(()=>{
    fetch(`/api/merchant/${MERCHANT_ID}/orders`).then(r=>r.json()).then(setOrders)
    const ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws')
    ws.onopen=()=> ws.send(JSON.stringify({type:'join', room:`merchant:${MERCHANT_ID}`}))
    ws.onmessage=(e)=>{
      const m = JSON.parse(e.data)
      if(m.type==='ORDER_UPDATE') fetch(`/api/merchant/${MERCHANT_ID}/orders`).then(r=>r.json()).then(setOrders)
    }
    return ()=> ws.close()
  },[])

  async function reportDelay(orderId:string, text:string){
    await fetch(`/api/merchant/${MERCHANT_ID}/report-delay`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ orderId, text }) })
  }

  return (
    <div style={{padding:16}}>
      <h1>Merchant Dashboard</h1>
      <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:16}}>
        <Column title="To Accept" items={orders.filter(o=>o.status==='pending')} onDelay={reportDelay}/>
        <Column title="Active" items={orders.filter(o=>['assigned','preparing','en_route_pickup','en_route_dropoff'].includes(o.status))} onDelay={reportDelay}/>
        <Column title="Completed" items={orders.filter(o=>o.status==='completed')} onDelay={reportDelay}/>
      </div>
    </div>
  )
}

function Column({title, items, onDelay}:{title:string, items:any[], onDelay:(id:string, text:string)=>void}){
  return <div><h3>{title}</h3>{items.map(o=><Item key={o.id} o={o} onDelay={onDelay}/>)}</div>
}

function Item({o,onDelay}:{o:any, onDelay:(id:string, text:string)=>void}){
  const [msg,setMsg] = useState('We are delayed by 15 minutes due to rush.')
  return <div style={{border:'1px solid #ddd', padding:12, borderRadius:12, marginBottom:8}}>
    <div><b>Order</b> {o.id.slice(0,8)}</div>
    <div>Status: {o.status}</div>
    <div>ETA: {o.etaSec ? Math.round(o.etaSec/60)+' min' : '-'}</div>
    <div style={{marginTop:8}}>
      <input style={{padding:8, border:'1px solid #ccc', borderRadius:8, width:'70%'}} value={msg} onChange={e=>setMsg(e.target.value)}/>
      <button style={{marginLeft:8, padding:'8px 12px'}} onClick={()=>onDelay(o.id,msg)}>Report Delay</button>
    </div>
  </div>
}
