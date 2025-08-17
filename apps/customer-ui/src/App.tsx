
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'

const CUSTOMER_ID = '00000000-0000-0000-0000-000000000101'

function decodePolyline(str:string){
  let index=0, lat=0, lng=0, coords:any[]=[]
  if(!str) return []
  while(index<str.length){
    let b, shift=0, result=0
    do{ b=str.charCodeAt(index++)-63; result |= (b & 0x1f) << shift; shift += 5 } while(b>=0x20)
    let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1)); lat += dlat
    shift=0; result=0
    do{ b=str.charCodeAt(index++)-63; result |= (b & 0x1f) << shift; shift += 5 } while(b>=0x20)
    let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1)); lng += dlng
    coords.push([lng/1e5, lat/1e5])
  }
  return coords
}

export default function App(){
  const [orderId,setOrderId] = useState('')
  const [order,setOrder] = useState<any>(null)
  const [messages,setMessages] = useState<any[]>([])
  const [ask,setAsk] = useState('Where is my delivery partner?')
  const mapRef = useRef<any>(null)
  const partnerMarker = useRef<any>(null)

  useEffect(()=>{
    const map = new maplibregl.Map({ container: 'map', style: 'https://demotiles.maplibre.org/style.json', center:[77.615,12.935], zoom: 13 })
    mapRef.current = map
    return ()=> map.remove()
  },[])

  async function load(){
    if(!orderId) return
    const o = await fetch(`/api/orders/${orderId}`).then(r=>r.json()); setOrder(o)
    const msgs = await fetch(`/api/chat/feed/${orderId}`).then(r=>r.json()); setMessages(msgs)
    draw(o)
    const ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws')
    ws.onopen = () => { ws.send(JSON.stringify({type:'join', room:`order:${orderId}`})) }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if(m.type==='MESSAGE') setMessages((prev)=>[...prev, m.message])
      if(m.type==='ORDER_UPDATE') setOrder((prev:any)=> ({...prev, status:m.status||prev.status, etaSec:m.etaSec||prev.etaSec}))
      if(m.type==='LOCATION'){
        if(!partnerMarker.current) partnerMarker.current = new maplibregl.Marker({color:'#1f2937'}).setLngLat([m.lng,m.lat]).addTo(mapRef.current)
        else partnerMarker.current.setLngLat([m.lng,m.lat])
      }
    }
  }

  function draw(o:any){
    const map = mapRef.current; if(!map || !o) return
    const r = o.routes?.[0]
    const origin = [o.pickupLng, o.pickupLat]
    const dest = [o.dropLng, o.dropLat]
    let coordinates:any[] = (r?.overviewPolyline ? decodePolyline(r.overviewPolyline): [origin, dest])
    const line = { type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'LineString', coordinates } }] }
    if(map.getSource('route')){ (map.getSource('route') as any).setData(line) }
    else { map.addSource('route', { type:'geojson', data: line }); map.addLayer({ id:'route', type:'line', source:'route', paint:{ 'line-width': 4 } }) }
    new maplibregl.Marker({color:'#2ecc71'}).setLngLat(origin).addTo(map)
    new maplibregl.Marker({color:'#e74c3c'}).setLngLat(dest).addTo(map)
    map.fitBounds([origin, dest], { padding: 80 })
  }

  async function doAsk(){
    await fetch(`/api/customer/${CUSTOMER_ID}/ask`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ orderId, text: ask }) })
  }

  return (
    <div style={{padding:16}}>
      <h1>Customer Portal</h1>
      <div style={{marginBottom:8}}>
        <input placeholder="Paste ORDER_ID" value={orderId} onChange={e=>setOrderId(e.target.value)} style={{padding:8, borderRadius:8, border:'1px solid #ddd', width:360}}/>
        <button onClick={load} style={{marginLeft:8, padding:'8px 12px'}}>Load</button>
      </div>
      <div id="map" style={{width:'100%', height:'50vh', borderRadius:12}} />
      {order && <div style={{marginTop:8}}>
        <b>Status</b>: {order.status} &nbsp; <b>ETA</b>: {order.etaSec ? Math.round(order.etaSec/60)+' min' : '-'}
      </div>}
      <div style={{marginTop:8}}>
        <input value={ask} onChange={e=>setAsk(e.target.value)} style={{padding:8, borderRadius:8, border:'1px solid #ddd', width:360}}/>
        <button onClick={doAsk} style={{marginLeft:8, padding:'8px 12px'}}>Ask Agent</button>
      </div>
      <div style={{marginTop:16}}>
        <h3>Messages</h3>
        <div>{messages.map((m,i)=>(<div key={i} style={{padding:'6px 8px', margin:'4px 0', background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:8}}><b>{m.role}</b>: {m.text}</div>))}</div>
      </div>
    </div>
  )
}
