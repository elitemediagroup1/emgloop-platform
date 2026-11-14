'use server';
import { revalidatePath } from 'next/cache';
import { ttoMediaService } from './runtime';
import { redirect } from 'next/navigation';
import type { TikTokBusinessKind } from '@emgloop/providers';
import { BUSINESS_SETTINGS, businessPrincipal, businessRepository, businessService } from './runtime';
async function begin(kind: TikTokBusinessKind) {
  let url: string | null = null;
  try { const p = await businessPrincipal(); if (p) url = await businessService(kind).begin(p, kind); } catch { /* safe outcome only */ }
  redirect(url ?? `${BUSINESS_SETTINGS}?outcome=NOT_READY`);
}
async function disconnect(kind: TikTokBusinessKind) {
  let removed = false;
  try { const p = await businessPrincipal(); if (p) removed = await businessRepository().disconnect(p, kind); } catch { /* safe outcome only */ }
  redirect(`${BUSINESS_SETTINGS}?outcome=${removed ? 'DISCONNECTED' : 'FAILED'}`);
}
export async function connectTto() { return begin('TTO'); }
export async function connectBusinessCreator() { return begin('CREATOR'); }
export async function disconnectTto() { return disconnect('TTO'); }
export async function disconnectBusinessCreator() { return disconnect('CREATOR'); }
export async function selectTtoSource(formData: FormData) {
  let ok=false;
  try { const p=await businessPrincipal(); if(p)ok=await ttoMediaService().select(p,String(formData.get('accountId')??'')); } catch { /* safe outcome only */ }
  redirect(`${BUSINESS_SETTINGS}?outcome=${ok?'SOURCE_SELECTED':'IMPORT_UNAVAILABLE'}`);
}
export async function refreshTtoCreator(formData: FormData) {
  let result='IMPORT_UNAVAILABLE';
  try { const p=await businessPrincipal(); if(p)result=await ttoMediaService().refresh(p,String(formData.get('profileId')??''),true); } catch { /* safe outcome only */ }
  revalidatePath('/app');
  redirect(`${BUSINESS_SETTINGS}?outcome=${['SYNCED','NOT_DUE'].includes(result)?result:'IMPORT_UNAVAILABLE'}`);
}
