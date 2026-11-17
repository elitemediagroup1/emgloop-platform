/** Exact normalized handles are required before different authorized readings can supplement each other. */
export function matchingTikTokHandles(account:string|null|undefined,report:string|null|undefined):boolean{
 const normalize=(v:string|null|undefined)=>v?.trim().replace(/^@/,'').toLowerCase()??'';
 const a=normalize(account),b=normalize(report);
 return /^[a-z0-9._]+$/.test(a)&&a===b;
}
