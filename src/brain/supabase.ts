/**
 * Cliente de Supabase (cerebro de Fransua). Se usa SOLO desde el backend con la
 * secret key (bypassa RLS). Guarda inteligencia derivada, nunca mensajes crudos.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

let client: SupabaseClient | null = null;

export function brainConfigured(): boolean {
  return !!config.supabaseUrl && !!config.supabaseSecretKey;
}

export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!brainConfigured()) {
    throw new Error("Supabase no configurado: define SUPABASE_URL y SUPABASE_SECRET_KEY en .env");
  }
  client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
