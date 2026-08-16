import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  const t = useTranslations("Auth.login");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <LoginForm />
      <p className="text-muted-foreground text-center text-sm">
        {t("noAccount")}{" "}
        <Link
          href="/sign-up"
          className="text-foreground underline underline-offset-4"
        >
          {t("signUpLink")}
        </Link>
      </p>
    </div>
  );
}
