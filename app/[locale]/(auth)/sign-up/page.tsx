import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { SignUpForm } from "@/components/auth/sign-up-form";

export default function SignUpPage() {
  const t = useTranslations("Auth.signUp");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <SignUpForm />
      <p className="text-muted-foreground text-center text-sm">
        {t("hasAccount")}{" "}
        <Link
          href="/login"
          className="text-foreground underline underline-offset-4"
        >
          {t("loginLink")}
        </Link>
      </p>
    </div>
  );
}
