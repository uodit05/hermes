
import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'

const PARTNER_ID = '00000000-0000-0000-0000-000000000201'

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
  const mapRef = useRef<any>(null)
  const [orders,setOrders] = useState<any[]>([])
  const [proposal,setProposal] = useState<any>(null)
  const [ask,setAsk] = useState('Is there a better route?')

  useEffect(()=>{
    const map = new maplibregl.Map({ container: 'map', style: 'https://demotiles.maplibre.org/style.json', center:[77.615,12.935], zoom: 13 })
    mapRef.current = map
    return ()=> map.remove()
  },[])

  useEffect(()=>{
    fetch(`/api/partner/${PARTNER_ID}/orders`).then(r=>r.json()).then((xs)=>{
      setOrders(xs||[]); if(xs?.[0]) draw(xs[0])
    })
    const ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws')
    ws.onopen = () => { ws.send(JSON.stringify({type:'join', room:`partner:${PARTNER_ID}`})) }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if(msg.type==='REROUTE_PROPOSAL') setProposal(msg)
      if(msg.type==='MESSAGE'){ /* toast */ }
    }
    return ()=> ws.close()
  },[])

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
    const o = orders[0]; if(!o) return
    await fetch(`/api/partner/${PARTNER_ID}/ask`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ orderId:o.id, text: ask }) })
  }
  async function accept(){
    const o = orders[0]; if(!o) return
    await fetch(`/api/partner/${PARTNER_ID}/reroute/${o.id}/accept`, { method:'POST' })
    setProposal(null)
    const xs = await fetch(`/api/partner/${PARTNER_ID}/orders`).then(r=>r.json()); setOrders(xs); draw(xs[0])
  }
  async function decline(){ setProposal(null) }

  const o = orders[0]
  return (
    <div style={{padding:16}}>
      <h1>Partner Console</h1>
      <div id="map" style={{width:'100%', height:'55vh', borderRadius:12, marginTop:8}} />
      {o && <div style={{marginTop:8}}>
        <b>Status</b>: {o.status} &nbsp; <b>ETA</b>: {o.etaSec ? Math.round(o.etaSec/60)+' min' : '-'}
      </div>}
      <div style={{marginTop:8}}>
        <input value={ask} onChange={e=>setAsk(e.target.value)} style={{padding:8, borderRadius:8, border:'1px solid #ddd', width:360}}/>
        <button onClick={doAsk} style={{marginLeft:8, padding:'8px 12px'}}>Ask Agent</button>
      </div>
      {proposal && (
        <div style={{position:'fixed', bottom:24, left:'50%', transform:'translateX(-50%)', background:'#fff', padding:16, borderRadius:12, boxShadow:'0 8px 30px rgba(0,0,0,.1)'}}>
          <div style={{fontWeight:600}}>Reroute suggested</div>
          <div>Save ~{Math.round((proposal.current.etaSec - proposal.alternate.etaSec)/60)} min</div>
          <div style={{display:'flex', gap:8, marginTop:8}}>
            <button onClick={accept} style={{padding:'8px 12px', background:'#16a34a', color:'#fff', border:'0', borderRadius:8}}>Accept</button>
            <button onClick={decline} style={{padding:'8px 12px', background:'#e5e7eb', border:'0', borderRadius:8}}>Decline</button>
          </div>
        </div>
      )}
    </div>
  )
}
