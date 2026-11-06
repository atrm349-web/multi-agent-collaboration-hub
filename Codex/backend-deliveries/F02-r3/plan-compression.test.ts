import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {validatePlan} from '../../work/upstream/agetor/packages/core/planner.ts';
const file=process.env.HUB_FRONTEND_APP??new URL('../../work/frontend-fix-r3/public/app.js',import.meta.url).pathname;
const app=await readFile(file,'utf8');
const sanitize=runInNewContext(app.slice(app.indexOf('function sanitizeExecutablePlan('),app.indexOf('\nglobalThis.apiRequest ='))+';sanitizeExecutablePlan;');
function step(stage:string,code:string,dependsOn:string[]=[],count=1){return {id:randomUUID(),stage,code,title:code,description:code,dependsOn,requiredCapabilities:['stream'],acceptanceCriteria:Array.from({length:count},(_,i)=>({id:`ac-${code}-${i}`,description:`${code} criterion ${i}`}))};}
test('single-chain compression preserves criteria, transitive dependencies and input; backend accepts',()=>{
 const a=step('implementation','A');const b=step('analysis','B',[a.id]);const c=step('implementation','C',[b.id]);const input=[a,b,c];const before=JSON.stringify(input);const result=sanitize(input);
 expect(result[1].dependsOn).toEqual([a.id]);expect(result[1].acceptanceCriteria.map((x:any)=>x.id)).toEqual(['ac-C-0','ac-B-0']);expect(validatePlan(result)).toHaveLength(2);expect(JSON.stringify(input)).toBe(before);
});
test('multiple analysis ancestors keep every criterion and remain valid on the backend',()=>{
 const a=step('implementation','A');const b=step('analysis','B',[a.id]);const c=step('analysis','C',[b.id]);const d=step('documentation','D',[c.id]);const result=sanitize([a,b,c,d]);
 expect(result[1].dependsOn).toEqual([a.id]);expect(result[1].acceptanceCriteria.map((x:any)=>x.id).sort()).toEqual(['ac-B-0','ac-C-0','ac-D-0']);expect(validatePlan(result)).toHaveLength(2);
});
test('analysis fan-out is rejected before mutation or duplicate criterion IDs can be submitted',()=>{
 const a=step('implementation','A');const b=step('analysis','B',[a.id]);const c=step('implementation','C',[b.id]);const d=step('documentation','D',[b.id]);const input=[a,b,c,d];const before=JSON.stringify(input);
 expect(()=>sanitize(input)).toThrow(/INVALID_INPUT:.*found 2/);expect(JSON.stringify(input)).toBe(before);
});
test('terminal analysis is rejected instead of discarding its acceptance criterion',()=>{
 const a=step('implementation','A');const b=step('analysis','B',[a.id]);expect(()=>sanitize([a,b])).toThrow(/INVALID_INPUT:.*found 0/);
});
test('orphan analysis is rejected instead of discarding its acceptance criterion',()=>{
 const a=step('implementation','A');const b=step('analysis','B');expect(()=>sanitize([a,b])).toThrow(/INVALID_INPUT:.*found 0/);
});
test('normal executable fan-out remains supported and passes backend validation',()=>{
 const a=step('implementation','A');const c=step('implementation','C',[a.id]);const d=step('documentation','D',[a.id]);const input=[a,c,d];const result=sanitize(input);expect(JSON.stringify(result)).toBe(JSON.stringify(input));expect(validatePlan(result)).toHaveLength(3);
});
test('empty/all-analysis plans cannot silently trigger server re-planning',()=>{
 expect(()=>sanitize([])).toThrow('INVALID_INPUT');expect(()=>sanitize([step('analysis','A')])).toThrow('INVALID_INPUT');
});
test('criterion inheritance refuses overflow beyond the backend limit',()=>{
 const a=step('implementation','A');const b=step('analysis','B',[a.id]);const c=step('documentation','C',[b.id],20);expect(()=>sanitize([a,b,c])).toThrow(/INVALID_INPUT:.*20 acceptance/);
});
test('terminal reserved final review cannot silently lose its criteria',()=>{
 const a=step('implementation','A');const b=step('review','FINAL-REVIEW',[a.id]);expect(()=>sanitize([a,b])).toThrow(/INVALID_INPUT:.*found 0/);
});
