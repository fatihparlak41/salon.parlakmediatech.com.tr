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
