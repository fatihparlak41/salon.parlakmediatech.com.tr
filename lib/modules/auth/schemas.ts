import { z } from "zod";

export const signInSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta adresi girin"),
  password: z.string().min(1, "Şifre gerekli"),
});

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Ad soyad gerekli").max(200),
  email: z.string().trim().email("Geçerli bir e-posta adresi girin"),
  password: z.string().min(8, "Şifre en az 8 karakter olmalı"),
});

export const resendConfirmationSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta adresi girin"),
});

/** Faz SAAS.1A — password rules for a NEW password (reset). Same minimum as
 * sign-up; the maximum is the 72-byte limit of the bcrypt hashing the auth
 * service uses (a longer value would be silently truncated or rejected). A
 * MINIMUM is never a cap on what a person may choose below the byte limit. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı`)
  .refine((value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES, `Şifre en fazla ${PASSWORD_MAX_BYTES} bayt uzunluğunda olabilir`)
  .refine((value) => value.trim().length > 0, "Şifre yalnızca boşluklardan oluşamaz");

// 254 characters is the practical ceiling of an address (RFC 5321); anything longer is not an address and is never
// handed to the auth provider.
export const forgotPasswordSchema = z.object({
  email: z.string().trim().max(254, "Geçerli bir e-posta adresi girin").email("Geçerli bir e-posta adresi girin"),
});

export const resetPasswordSchema = z
  .object({
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Şifreler eşleşmiyor",
  });
