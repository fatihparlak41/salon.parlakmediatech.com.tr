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
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Online randevu sayfasında görünür</legend>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-pricing`}>Fiyat türü</Label>
        <select
          id={`${idPrefix}-pricing`}
          className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
          value={value.pricingMode}
          onChange={(e) => set({ pricingMode: e.target.value as ExperienceForm["pricingMode"] })}
        >
          <option value="fixed">Sabit fiyat</option>
          <option value="inquiry">Fiyat için iletişime geçin (değişken)</option>
        </select>
        {inquiry && (
          <p className="text-muted-foreground text-xs">Fiyat gösterilmez, online randevu alınamaz; müşteri salonla iletişime geçer.</p>
        )}
      </div>

      {!inquiry && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-booking`}>Randevu</Label>
            <select
              id={`${idPrefix}-booking`}
              className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
              value={value.bookingMode}
              onChange={(e) => set({ bookingMode: e.target.value as ExperienceForm["bookingMode"] })}
            >
              <option value="direct">Online randevu alınabilir</option>
              <option value="inquiry">Yalnızca bilgi al (randevu salonla netleşir)</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={value.pricePublic} onCheckedChange={() => set({ pricePublic: !value.pricePublic })} />
            Fiyatı online sayfada göster
          </label>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-dmin`}>Görünen süre: en az (dk)</Label>
          <Input id={`${idPrefix}-dmin`} type="number" min={1} value={value.displayMin} onChange={(e) => set({ displayMin: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-dmax`}>en çok (dk)</Label>
          <Input id={`${idPrefix}-dmax`} type="number" min={1} value={value.displayMax} onChange={(e) => set({ displayMax: e.target.value })} />
        </div>
      </div>
      <p className="text-muted-foreground -mt-1 text-xs">Müşteriye gösterilen süre aralığıdır; takvimde ayrılan süre Takvim Süresidir.</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-summary`}>Kısa açıklama (kartta)</Label>
        <Input id={`${idPrefix}-summary`} maxLength={EXPERIENCE_TEXT_LIMITS.publicSummary} value={value.summary} onChange={(e) => set({ summary: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-badge`}>Etiket</Label>
        <Input id={`${idPrefix}-badge`} maxLength={EXPERIENCE_TEXT_LIMITS.badgeLabel} value={value.badge} onChange={(e) => set({ badge: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-details`}>İşlem hakkında</Label>
        <Textarea id={`${idPrefix}-details`} rows={3} maxLength={EXPERIENCE_TEXT_LIMITS.publicDetails} value={value.details} onChange={(e) => set({ details: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-prep`}>Randevu öncesi</Label>
        <Textarea id={`${idPrefix}-prep`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.preparationNote} value={value.preparation} onChange={(e) => set({ preparation: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-important`}>Önemli bilgi</Label>
        <Textarea id={`${idPrefix}-important`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.importantNote} value={value.important} onChange={(e) => set({ important: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-after`}>Randevu sonrası</Label>
        <Textarea id={`${idPrefix}-after`} rows={2} maxLength={EXPERIENCE_TEXT_LIMITS.aftercareNote} value={value.aftercare} onChange={(e) => set({ aftercare: e.target.value })} />
      </div>
    </fieldset>
  );
}
