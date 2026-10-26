"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { EXPERIENCE_TEXT_LIMITS, type ExperienceForm } from "@/lib/modules/services/experience";

/**
 * Faz BEAUTY.1A - the generic "online page" fields of a service, shared by the create dialog and the detail sheet. Everything
 * optional; a service that fills none of them behaves exactly as before. The price option is hidden for inquiry pricing
 * (the amount is never shown), and inquiry pricing forces inquiry booking.
 */
export function ServiceExperienceFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: ExperienceForm;
  onChange: (next: ExperienceForm) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<ExperienceForm>) => onChange({ ...value, ...patch });
  const inquiry = value.pricingMode === "inquiry";
  const select = "border-input bg-background h-8 rounded-lg border px-2 text-sm";
  const group = "flex flex-col gap-3 border-t pt-3 first:border-t-0 first:pt-0";
  const groupTitle = "text-sm font-medium";
  const hint = "text-muted-foreground text-xs";
  return (
    <fieldset className="flex min-w-0 flex-col gap-4 rounded-lg border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Online sayfa ve bilgilendirme</legend>

      <section className={group} aria-label="Fiyat ve randevu">
        <h4 className={groupTitle}>Fiyat ve randevu</h4>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-pricing`}>Fiyat türü</Label>
          <select
            id={`${idPrefix}-pricing`}
            className={select}
            value={value.pricingMode}
            onChange={(e) => set({ pricingMode: e.target.value as ExperienceForm["pricingMode"] })}
          >
            <option value="fixed">Sabit fiyat</option>
            <option value="inquiry">Fiyat için iletişime geçin (değişken)</option>
          </select>
          {inquiry && <p className={hint}>Fiyat gösterilmez, online randevu alınamaz; müşteri salonla iletişime geçer.</p>}
        </div>

        {!inquiry && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-booking`}>Randevu</Label>
              <select
                id={`${idPrefix}-booking`}
                className={select}
                value={value.bookingMode}
                onChange={(e) => set({ bookingMode: e.target.value as ExperienceForm["bookingMode"] })}
              >
                <option value="direct">Online randevu alınabilir</option>
                <option value="inquiry">Yalnızca bilgi al (randevu salonla netleşir)</option>
              </select>
              {value.bookingMode === "inquiry" ? (
                <p className={`${hint} text-amber-700 dark:text-amber-400`}>
                  Bu hizmet şu an yalnızca bilgi alma olarak görünüyor ve takvime yazılamaz. Gerçek takvim süresini girip “Online randevu alınabilir” seçtiğinizde randevuya açılır; süreyi siz girene kadar Takvim Süresi alanındaki değer geçicidir.
                </p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.pricePublic} onCheckedChange={() => set({ pricePublic: !value.pricePublic })} />
              Fiyatı online sayfada göster
            </label>
          </>
        )}
      </section>

      <section className={group} aria-label="Online sayfada görünüm">
        <h4 className={groupTitle}>Online sayfada nasıl görünsün?</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-dmin`}>Gösterilen süre: en az (dk)</Label>
            <Input id={`${idPrefix}-dmin`} type="number" min={1} value={value.displayMin} onChange={(e) => set({ displayMin: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-dmax`}>en çok (dk)</Label>
            <Input id={`${idPrefix}-dmax`} type="number" min={1} value={value.displayMax} onChange={(e) => set({ displayMax: e.target.value })} />
          </div>
        </div>
        <p className={`${hint} -mt-1`}>Müşteriye gösterilen süre aralığıdır; takvimde ayrılan süre Takvim Süresidir.</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-summary`}>Kısa açıklama (hizmet kartında)</Label>
          <Input id={`${idPrefix}-summary`} maxLength={EXPERIENCE_TEXT_LIMITS.publicSummary} value={value.summary} onChange={(e) => set({ summary: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-badge`}>Etiket (isteğe bağlı)</Label>
          <Input id={`${idPrefix}-badge`} maxLength={EXPERIENCE_TEXT_LIMITS.badgeLabel} value={value.badge} onChange={(e) => set({ badge: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-details`}>İşlem hakkında (ayrıntılı açıklama)</Label>
          <Textarea id={`${idPrefix}-details`} rows={3} maxLength={EXPERIENCE_TEXT_LIMITS.publicDetails} value={value.details} onChange={(e) => set({ details: e.target.value })} />
        </div>
      </section>

      <section className={group} aria-label="Müşteriye notlar">
        <h4 className={groupTitle}>Müşteriye notlar</h4>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-prep`}>Randevu öncesi</Label>
          <Textarea id={`${idPrefix}-prep`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.preparationNote} value={value.preparation} onChange={(e) => set({ preparation: e.target.value })} />
          <p className={hint}>Online sayfada gösterilir; e-posta bildirimleri açıksa randevu e-postasında da kısa bir not olarak yer alır.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-important`}>Önemli bilgi</Label>
          <Textarea id={`${idPrefix}-important`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.importantNote} value={value.important} onChange={(e) => set({ important: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-after`}>Randevu sonrası</Label>
          <Textarea id={`${idPrefix}-after`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.aftercareNote} value={value.aftercare} onChange={(e) => set({ aftercare: e.target.value })} />
          <p className={hint}>Online hizmet sayfasında gösterilir; müşteriye ayrıca mesaj gönderilmez.</p>
        </div>
      </section>

      <section className={group} aria-label="Tekrar randevu">
        <h4 className={groupTitle}>Tekrar randevu (yalnızca sizin için)</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-rmin`}>Önerilen tekrar: en az (gün)</Label>
            <Input id={`${idPrefix}-rmin`} type="number" min={1} value={value.rebookMin} onChange={(e) => set({ rebookMin: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-rmax`}>en çok (gün)</Label>
            <Input id={`${idPrefix}-rmax`} type="number" min={1} value={value.rebookMax} onChange={(e) => set({ rebookMax: e.target.value })} />
          </div>
        </div>
        <p className={`${hint} -mt-1`}>İşlem tamamlandıktan sonra müşteri geçmişinde “Tekrar randevu zamanı” olarak görünür; müşteriye otomatik mesaj gitmez.</p>
      </section>
    </fieldset>
  );
}
