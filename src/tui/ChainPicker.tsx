import React,{useState} from 'react'
import {Menu} from './ActionMenu'
import type {SearchRef} from '../core/db'
/** Relationship and current-filter annotation for an exact session. */
export interface ChainItem {uid:string;parentLabel:string;matchesFilters:boolean}
/** Choosing a member never changes the committed search filters. */
export function ChainPicker({items,rows,columns,onInspect,onResume,onClose,helpOpen,onHelpClose,actionForMember}: {
 actionForMember:(uid:string)=>{label:string;enabled:boolean;reason:string|null};items:readonly (SearchRef&ChainItem)[];helpOpen?:boolean;onHelpClose?:()=>void;rows:number;columns:number;onInspect:(uid:string)=>void;onResume:(uid:string)=>void;onClose:()=>void
}) {
 const [chosen,setChosen]=useState<string|null>(null)
 if(chosen) return <Menu key={chosen} title={`Related session: ${chosen}`} items={[
 {id:'inspect',label:'Inspect history'},{id:'resume',...actionForMember(chosen)},
 ]} rows={rows} columns={columns} onSelect={id=>id==='inspect'?onInspect(chosen):onResume(chosen)} helpOpen={helpOpen} onHelpClose={onHelpClose} onClose={()=>setChosen(null)}/>
 return <Menu title={`Related sessions (${items.length} visible)`} items={items.map(item=>({id:item.uid,
 label:`${item.client} ${Number.isFinite(item.endedAt)&&item.endedAt>0&&item.endedAt<=8.64e15?new Date(item.endedAt).toISOString().slice(0,16):'Unknown time'} ${item.title??'(no title)'} · ${item.parentLabel}${item.matchesFilters?'':' · outside filters'}`}))}
 rows={rows} columns={columns} onSelect={setChosen} helpOpen={helpOpen} onHelpClose={onHelpClose} onClose={onClose}/>
}
