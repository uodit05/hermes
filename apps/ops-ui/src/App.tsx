
import { useEffect, useState } from 'react'

export default function App(){
  const [logs,setLogs] = useState<any>({ logs:[], msgs:[], runs:[] })

  async function load(){
    const x = await fetch(`/api/ops/logs`).then(r=>r.json()); setLogs(x)
  }
  useEffect(()=>{ load() },[])

  return (
    <div style={{padding:16}}>
      <h1>Ops</h1>
      <button onClick={load} style={{padding:'6px 10px'}}>Refresh</button>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginTop:12}}>
        <div>
          <h3>Tool Calls</h3>
          <div style={{maxHeight:'60vh', overflow:'auto', border:'1px solid #eee', borderRadius:8, padding:8}}>
            {logs.logs.map((l:any,i:number)=>(
              <div key={i} style={{borderBottom:'1px solid #f0f0f0', padding:'8px 0'}}>
                <div><b>{l.tool}</b> <small>({l.status}, {l.latencyMs}ms)</small></div>
                <div style={{fontSize:12, color:'#64748b'}}>order:{l.orderId} role:{l.role}</div>
                <pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(l.response,null,2)}</pre>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3>Agent Runs</h3>
          <div style={{maxHeight:'30vh', overflow:'auto', border:'1px solid #eee', borderRadius:8, padding:8}}>
            {logs.runs.map((r:any,i:number)=>(
              <div key={i} style={{borderBottom:'1px solid #f0f0f0', padding:'6px 0'}}>
                <div><b>{r.actorRole}</b> → order:{r.orderId}</div>
                <div style={{fontSize:12, color:'#64748b'}}>status: {r.status}</div>
                <pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(r.plan,null,2)}</pre>
              </div>
            ))}
          </div>
          <h3 style={{marginTop:16}}>Messages</h3>
          <div style={{maxHeight:'30vh', overflow:'auto', border:'1px solid #eee', borderRadius:8, padding:8}}>
            {logs.msgs.map((m:any,i:number)=>(
              <div key={i} style={{borderBottom:'1px solid #f0f0f0', padding:'6px 0'}}>
                <b>{m.role}</b> order:{m.orderId} — {m.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
