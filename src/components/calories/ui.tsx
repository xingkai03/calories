import type { ReactNode } from 'react';
import type { EffectiveBurned, GarminStatus } from '../../lib/calories/garmin';

export type IconName = 'leaf' | 'plus' | 'left' | 'right' | 'close' | 'edit' | 'trash' | 'settings' | 'download' | 'lock' | 'logout' | 'check' | 'search' | 'history' | 'calendar' | 'arrow' | 'book' | 'watch' | 'refresh';

export function Icon({ name, size = 20, ...props }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    leaf: <><path d="M20 4c-1 8-2 15-10 15a6 6 0 0 1-6-6c0-8 8-8 16-9Z"/><path d="m4 20 11-11"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    left: <path d="m14 6-6 6 6 6"/>,
    right: <path d="m10 6 6 6-6 6"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    edit: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    logout: <><path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6M12 8v4l3 2"/></>,
    calendar: <><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4M16 3v4M4 10h16M8 14h2M14 14h2"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    book: <><path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4ZM20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3V4Z"/></>,
    watch: <><rect x="6" y="6" width="12" height="12" rx="4"/><path d="m9 6 1-4h4l1 4M9 18l1 4h4l1-4M12 9v3l2 1"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

export const number = (value: number, decimals = 0) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: decimals }).format(value);
export const signedNumber = (value: number, decimals = 1) => value > 0 ? `+${number(value, decimals)}` : value < 0 ? `−${number(Math.abs(value), decimals)}` : '0';
export const readableDate = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', options).format(new Date(`${date}T12:00:00`));
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const newId = () => crypto.randomUUID();
export const unitLabel = (unit: string, quantity: number) => unit === 'piece' ? (quantity === 1 ? 'piece' : 'pieces') : unit;
export const previewNumber = (value: string) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
export const syncTime = (timestamp: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
export const burnedLabel = (value: EffectiveBurned) => value.source === 'garmin' ? value.unavailable ? 'Garmin unavailable' : value.restingEstimate ? 'Garmin resting estimate' : value.predicted ? 'Garmin prediction' : value.predictionUnavailable ? 'Garmin partial total' : 'Garmin' : 'Manual override';
export function burnedFormula(value: EffectiveBurned) {
  if (value.unavailable) return 'No imported total is available for this date, and no completed Garmin resting reading is available yet';
  if (value.restingEstimate && value.restingDay) return `${number(value.restingDay.resting)} resting kcal from ${readableDate(value.restingDay.date, { day: 'numeric', month: 'short', year: 'numeric' })}, used as an estimate for this day`;
  if (value.predicted && value.day && value.restingDay) return `${number(value.day.active)} active today + ${number(value.restingDay.resting)} resting yesterday (${readableDate(value.restingDay.date, { day: 'numeric', month: 'short' })})`;
  if (value.predictionUnavailable) return 'Yesterday’s resting calories are unavailable. Using Garmin’s partial total so far';
  return value.day ? `${number(value.day.active)} active + ${number(value.day.resting)} resting kcal` : '';
}
export function burnedSyncTime(value: EffectiveBurned) {
  if (value.restingEstimate && value.restingDay) return `Resting imported ${syncTime(value.restingDay.synced_at)}`;
  if (!value.day) return '';
  return value.predicted && value.restingDay && value.day.synced_at !== value.restingDay.synced_at ? `Active updated ${syncTime(value.day.synced_at)} · Resting imported ${syncTime(value.restingDay.synced_at)}` : `Updated ${syncTime(value.day.synced_at)}`;
}
export const staleImport = (timestamp: string | null) => Boolean(timestamp && Date.now() - Date.parse(timestamp) > 2 * 60 * 60 * 1000);
export const garminStatusLabel = (status: GarminStatus) => ({ not_connected: 'Not connected', connected: status.last_sync_at ? staleImport(status.last_sync_at) ? 'Needs a new import' : 'Connected' : 'Waiting for first import', needs_login: 'Sign-in needed', error: 'Import needs attention' })[status.state];
export function garminErrorMeaning(code: string | null) {
  if (!code) return '';
  const meanings: Record<string, string> = { missing_data: 'Garmin hasn’t reported complete calorie data yet.', upstream_unavailable: 'Garmin couldn’t be reached. A later import will try again.', needs_login: 'Sign in to Garmin again to resume automatic imports.', rate_limited: 'Garmin is temporarily limiting requests. A later import will try again.' };
  return meanings[code] ?? 'The last import could not finish. Check the connection setup if this continues.';
}

export function ModalHeader({ title, eyebrow, onClose }: { title: string; eyebrow: string; onClose: () => void }) {
  return <div className="cal-modal-heading"><div><div className="cal-eyebrow">{eyebrow}</div><h2 id="cal-dialog-title">{title}</h2></div><button className="cal-icon-button" type="button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></div>;
}

export function NumericField({ label, value, onChange, unit = 'g', min = 0, required = true, describedBy }: { label: string; value: string; onChange: (value: string) => void; unit?: string; min?: number; required?: boolean; describedBy?: string }) {
  return <label>{label}<span className="cal-unit-input"><input type="number" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} min={min} max={100000000} step="any" required={required} aria-describedby={describedBy}/><span>{unit}</span></span></label>;
}


export function downloadFile(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
