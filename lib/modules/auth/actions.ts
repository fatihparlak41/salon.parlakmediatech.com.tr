"use server";

import { createClient } from "@/lib/supabase/server";
// Plain next/navigation — see lib/auth/session.ts for why server-side
// redirects don't use lib/i18n/navigation's locale-aware version.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/errors";
import { fail } from "@/lib/errors";
import { signInSchema, signUpSchema } from "./schemas";

export async function signInAction(
  _prevState: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz form",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return fail("UNAUTHENTICATED", "E-posta veya şifre hatalı");
  }

  redirect("/");
}

export async function signUpAction(
  _prevState: ActionResult<{ email: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fail(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Geçersiz form",
    );
  }

  const supabase = await createClient();
  // NEXT_PUBLIC_SITE_URL wins once set (the real custom domain, once
  // attached). Until then, Vercel's own VERCEL_URL — auto-populated per
  // deployment, including a unique one per Preview build — resolves this
  // correctly with no per-deployment config. Bare localhost fallback is
  // for `pnpm dev` only.
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${siteUrl}/auth/callback`,
    },
  });

  if (error) {
    if (error.code === "user_already_exists") {
      return fail("CONFLICT", "Bu e-posta adresiyle zaten bir hesap var");
    }
    return fail("UNEXPECTED", "Kayıt oluşturulamadı, lütfen tekrar deneyin");
  }

  return { success: true, data: { email: parsed.data.email } };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
