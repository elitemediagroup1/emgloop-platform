'use server';
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
